#include "cfar/DataLoader.hpp"
#include <cmath>
#include <random>
#include <sstream>
#include <iomanip>
#include <chrono>

static constexpr float PI = 3.14159265358979323846f;

// JSON helpers — no third-party library
static std::string jsonFloat(float v) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(4) << v;
    return ss.str();
}

static std::string jsonDouble(double v) {
    std::ostringstream ss;
    ss << std::fixed << std::setprecision(2) << v;
    return ss.str();
}

static std::string jsonInt(int64_t v) {
    return std::to_string(v);
}

static std::string jsonArrayF(const std::vector<float>& arr) {
    std::string s = "[";
    for (size_t i = 0; i < arr.size(); ++i) {
        if (i) s += ',';
        std::ostringstream ss;
        ss << std::fixed << std::setprecision(4) << arr[i];
        s += ss.str();
    }
    s += ']';
    return s;
}

static float rayleigh(std::mt19937& rng, float sigma) {
    std::uniform_real_distribution<float> dist(1e-9f, 1.0f);
    return sigma * std::sqrt(-2.0f * std::log(dist(rng)));
}

std::vector<std::vector<float>> DataLoader::generateSynthetic(
    const RadarConfig& config,
    uint32_t n_chirps,
    uint32_t frame_index)
{
    const uint32_t N        = config.n_range_bins;  // 512
    const uint32_t fft_size = 2 * N;                // 1024

    // Noise kept visible so CFAR threshold is meaningful on the chart.
    const float noise_sigma = 0.05f;

    // Phase advances ~0.04 rad/frame → targets drift and scintillate visibly.
    float phase = static_cast<float>(frame_index) * 0.04f;

    struct Target {
        float bin_frac;    // nominal range bin as fraction of N
        float amp_base;    // base amplitude (peak after Hann FFT ≈ amp*0.25)
        float drift_amp;   // range drift amplitude in bins
        float drift_rate;  // drift frequency (rad/frame units)
        float scint_rate;  // scintillation (AM) rate
        float scint_ph;    // scintillation phase offset
        float dphi;        // Doppler phase advance per chirp (rad)
    };

    // 5 targets — SNR ≈ 19/16/18/12/8 dB — mixed strength for realistic scene.
    static const Target TARGETS[] = {
        { 0.100f, 12.0f, 3.0f, 0.20f,  0.15f, 0.00f,  0.31f },
        { 0.246f,  8.0f, 2.5f, 0.13f,  0.22f, 1.05f,  0.51f },
        { 0.613f, 10.0f, 4.5f, 0.09f,  0.18f, 2.10f, -0.23f },
        { 0.390f,  5.5f, 6.0f, 0.17f,  0.30f, 3.14f,  0.71f },
        { 0.780f,  3.5f, 1.5f, 0.25f,  0.10f, 0.52f, -0.44f },
    };
    constexpr int N_TARGETS = static_cast<int>(sizeof(TARGETS) / sizeof(TARGETS[0]));

    std::mt19937 rng(42 + frame_index);
    std::normal_distribution<float> nd(0.0f, noise_sigma);

    std::vector<std::vector<float>> chirps(n_chirps);
    for (uint32_t c = 0; c < n_chirps; ++c) {
        std::vector<float>& iq = chirps[c];
        iq.resize(2 * N, 0.0f);

        // Complex white Gaussian noise background
        for (uint32_t t = 0; t < N; ++t) {
            iq[2*t]   = nd(rng);
            iq[2*t+1] = nd(rng);
        }

        // Complex sinusoidal targets with drift and Swerling-I scintillation
        for (int ti = 0; ti < N_TARGETS; ++ti) {
            const Target& tgt = TARGETS[ti];

            // Drifting range bin
            float bin_f = tgt.bin_frac * static_cast<float>(N)
                        + tgt.drift_amp * std::sin(phase * tgt.drift_rate
                                                   + static_cast<float>(ti));
            uint32_t b = static_cast<uint32_t>(
                std::max(2.0f, std::min(bin_f, static_cast<float>(N - 3))));

            // Amplitude scintillation (±25 %)
            float scint = 1.0f + 0.25f * std::sin(phase * tgt.scint_rate + tgt.scint_ph);
            float amp   = tgt.amp_base * scint;

            float chirp_ph = static_cast<float>(c) * tgt.dphi;
            for (uint32_t t = 0; t < N; ++t) {
                float angle = 2.0f * PI * static_cast<float>(b)
                              * static_cast<float>(t)
                              / static_cast<float>(fft_size)
                              + chirp_ph;
                iq[2*t]   += amp * std::cos(angle);
                iq[2*t+1] += amp * std::sin(angle);
            }
        }
    }
    return chirps;
}

std::string DataLoader::saveFrameJSON(const RadarFrame& frame) {
    std::string s;
    s.reserve(8192);
    s += '{';

    s += "\"frameIndex\":" + jsonInt(frame.frame_index) + ',';
    s += "\"timestamp\":"  + jsonInt(frame.timestamp_ms) + ',';
    s += "\"rangeProfile\":" + jsonArrayF(frame.range_profile) + ',';
    s += "\"cfarThreshold\":" + jsonArrayF(frame.cfar_threshold) + ',';
    s += "\"dopplerMap\":" + jsonArrayF(frame.doppler_map) + ',';
    s += "\"dopplerSize\":{\"rb\":" + jsonInt(frame.doppler_rb) + ",\"dop\":" + jsonInt(frame.doppler_dop) + "},";

    // dopplerTargets
    s += "\"dopplerTargets\":[";
    for (size_t i = 0; i < frame.doppler_targets.size(); ++i) {
        if (i) s += ',';
        const auto& dt = frame.doppler_targets[i];
        s += "{\"rb\":" + jsonInt(dt.rb)
           + ",\"db\":" + jsonInt(dt.db)
           + ",\"velocity\":" + jsonFloat(dt.velocity)
           + ",\"bin\":" + jsonFloat(dt.bin) + "}";
    }
    s += "],";

    // detections
    s += "\"detections\":[";
    for (size_t i = 0; i < frame.detections.size(); ++i) {
        if (i) s += ',';
        const auto& d = frame.detections[i];
        s += "{\"id\":\"" + d.id + "\""
           + ",\"rangeBin\":" + jsonInt(d.range_bin)
           + ",\"rangeMetres\":" + jsonFloat(d.range_m)
           + ",\"magnitude\":" + jsonFloat(d.magnitude)
           + ",\"threshold\":" + jsonFloat(d.threshold)
           + ",\"snrDb\":" + jsonFloat(d.snr_db) + "}";
    }
    s += "],";

    s += "\"processingTimeUs\":" + jsonDouble(frame.processing_time_us) + ',';
    s += "\"alpha\":" + jsonFloat(frame.alpha) + ',';
    s += "\"rangeStep\":" + jsonFloat(frame.range_step);

    s += '}';
    return s;
}

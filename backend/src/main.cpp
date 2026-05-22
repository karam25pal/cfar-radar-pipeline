#include "cfar/RangeProfile.hpp"
#include "cfar/CFARDetector.hpp"
#include "cfar/FFTProcessor.hpp"
#include "cfar/DopplerProcessor.hpp"
#include "cfar/DataLoader.hpp"
#include "cfar/BenchmarkTimer.hpp"

#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include <algorithm>
#include <numeric>
#include <chrono>
#include <thread>
#include <cmath>
#include <cstring>

static std::string variantName(CFARDetector::Variant v) {
    return v == CFARDetector::Variant::CA ? "CA" : "GO";
}

static void printBenchmarkTable(const CFARDetector::Params& p, uint32_t fft_size,
                                 double mean_us, double min_us, double p99_us,
                                 double throughput)
{
    auto pad = [](const std::string& s, int w) {
        std::string r = s;
        while (static_cast<int>(r.size()) < w) r += ' ';
        return r;
    };
    auto row = [&](const std::string& k, const std::string& v) {
        std::string line = "║  " + pad(k, 16) + ": " + pad(v, 26) + "║";
        std::cout << line << "\n";
    };

    std::cout << "╔══════════════════════════════════════════════════╗\n";
    std::cout << "║   CA-CFAR Real-Time Signal Processor             ║\n";
    std::cout << "║   Benchmark · 10,000 iterations · x86-64         ║\n";
    std::cout << "╠══════════════════════════════════════════════════╣\n";
    row("FFT Size",       std::to_string(fft_size) + " bins");
    row("Guard Cells",    std::to_string(p.guard_cells));
    row("Training Cells", std::to_string(p.training_cells));
    {
        std::ostringstream ss; ss << std::scientific << std::setprecision(0) << p.pfa;
        row("Pfa", ss.str());
    }
    row("Variant", variantName(p.variant) + "-CFAR");
    std::cout << "╠══════════════════════════════════════════════════╣\n";
    {
        std::ostringstream ss; ss << std::fixed << std::setprecision(2) << mean_us << " µs/frame";
        row("Mean latency", ss.str());
    }
    {
        std::ostringstream ss; ss << std::fixed << std::setprecision(2) << min_us << " µs";
        row("Min latency", ss.str());
    }
    {
        std::ostringstream ss; ss << std::fixed << std::setprecision(2) << p99_us << " µs";
        row("P99 latency", ss.str());
    }
    {
        std::ostringstream ss;
        ss << std::fixed << std::setprecision(0) << throughput << " frames/sec";
        row("Throughput", ss.str());
    }
    std::cout << "╚══════════════════════════════════════════════════╝\n";
}

static RadarFrame buildFrame(uint32_t frame_idx,
                              const RadarConfig& config,
                              const CFARDetector& detector,
                              const FFTProcessor& fft,
                              const DopplerProcessor& doppler)
{
    auto chirps = DataLoader::generateSynthetic(config, 64, frame_idx);

    // Range profile from first chirp FFT
    auto range_profile = fft.process(chirps[0].data(),
                                      static_cast<uint32_t>(chirps[0].size()));

    // Doppler map
    std::vector<std::vector<float>> chirp_profiles;
    chirp_profiles.reserve(chirps.size());
    for (auto& c : chirps)
        chirp_profiles.push_back(fft.process(c.data(), static_cast<uint32_t>(c.size())));

    auto doppler_map = doppler.compute(chirp_profiles);

    // CFAR threshold + detect
    BenchmarkTimer timer;
    timer.start();
    auto threshold  = detector.computeThreshold(range_profile);
    auto detections = detector.detect(range_profile, threshold, config);
    double elapsed_us = timer.stopUs();

    // Doppler targets from map
    DopplerProcessor dp2(config.n_range_bins, config.n_doppler_bins);
    auto doppler_targets = dp2.extractTargets(doppler_map, config.n_range_bins, 0.4f);

    // Assign velocity to detections by nearest doppler target
    for (auto& det : detections) {
        float best_dist = 1e9f;
        for (const auto& dt : doppler_targets) {
            float frac = static_cast<float>(det.range_bin) / config.n_range_bins
                         * static_cast<float>(config.n_range_bins);
            float dist = std::abs(static_cast<float>(dt.rb) - frac);
            if (dist < best_dist) {
                best_dist = dist;
                det.velocity_ms = dt.velocity;
                det.doppler_bin = dt.db;
            }
        }
    }

    auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    RadarFrame frame;
    frame.frame_index      = frame_idx;
    frame.timestamp_ms     = now_ms;
    frame.range_profile    = std::move(range_profile);
    frame.cfar_threshold   = std::move(threshold);
    frame.doppler_map      = std::move(doppler_map);
    frame.detections       = std::move(detections);
    frame.doppler_targets  = std::move(doppler_targets);
    frame.doppler_rb       = config.n_range_bins;
    frame.doppler_dop      = config.n_doppler_bins;
    frame.processing_time_us = elapsed_us;
    frame.alpha            = detector.alpha();
    frame.range_step       = config.range_resolution_m();
    return frame;
}

int main(int argc, char* argv[]) {
    // Defaults
    std::string mode     = "synthetic";
    std::string format   = "terminal";
    uint32_t n_frames    = 1;
    uint32_t fft_size    = 1024;
    uint32_t guard_cells = 4;
    uint32_t train_cells = 16;
    float    pfa         = 1e-4f;
    CFARDetector::Variant variant = CFARDetector::Variant::CA;
    bool     do_benchmark = false;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto nextArg = [&]() -> std::string {
            return (i + 1 < argc) ? argv[++i] : "";
        };
        if (a == "--mode")     mode       = nextArg();
        else if (a == "--format")   format     = nextArg();
        else if (a == "--frames")   n_frames   = std::stoul(nextArg());
        else if (a == "--fft-size") fft_size   = std::stoul(nextArg());
        else if (a == "--guard")    guard_cells = std::stoul(nextArg());
        else if (a == "--training") train_cells = std::stoul(nextArg());
        else if (a == "--pfa")      pfa         = std::stof(nextArg());
        else if (a == "--variant") {
            std::string v = nextArg();
            variant = (v == "GO") ? CFARDetector::Variant::GO : CFARDetector::Variant::CA;
        }
        else if (a == "--benchmark") do_benchmark = true;
        else if (a == "--scene-id") { nextArg(); /* ignored — synthetic only */ }
    }

    RadarConfig config;
    config.n_range_bins   = fft_size / 2;
    config.n_doppler_bins = 64;

    CFARDetector::Params params;
    params.guard_cells    = guard_cells;
    params.training_cells = train_cells;
    params.pfa            = pfa;
    params.variant        = variant;

    CFARDetector detector(params);
    FFTProcessor  fft_proc(fft_size);
    DopplerProcessor doppler(config.n_range_bins, config.n_doppler_bins);

    if (do_benchmark) {
        const uint32_t ITERS = 10000;
        std::vector<double> latencies;
        latencies.reserve(ITERS);

        for (uint32_t i = 0; i < ITERS; ++i) {
            auto chirps  = DataLoader::generateSynthetic(config, 64, i);
            auto profile = fft_proc.process(chirps[0].data(),
                                             static_cast<uint32_t>(chirps[0].size()));
            BenchmarkTimer t; t.start();
            auto thresh = detector.computeThreshold(profile);
            detector.detect(profile, thresh, config);
            latencies.push_back(t.stopUs());
        }

        std::sort(latencies.begin(), latencies.end());
        double mean_us    = std::accumulate(latencies.begin(), latencies.end(), 0.0) / ITERS;
        double min_us     = latencies.front();
        double p99_us     = latencies[static_cast<size_t>(ITERS * 0.99)];
        double throughput = mean_us > 0.0 ? 1e6 / mean_us : 0.0;

        printBenchmarkTable(params, fft_size, mean_us, min_us, p99_us, throughput);
        return 0;
    }

    if (mode == "stream" && format == "json") {
        // Continuous stream mode: output one JSON frame per line, 25fps
        uint32_t frame_idx = 0;
        while (true) {
            auto frame = buildFrame(frame_idx, config, detector, fft_proc, doppler);
            std::cout << DataLoader::saveFrameJSON(frame) << "\n";
            std::cout.flush();
            ++frame_idx;
            std::this_thread::sleep_for(std::chrono::milliseconds(40));
        }
        return 0;
    }

    // Single-frame or multi-frame output
    for (uint32_t fi = 0; fi < n_frames; ++fi) {
        auto frame = buildFrame(fi, config, detector, fft_proc, doppler);
        if (format == "json") {
            std::cout << DataLoader::saveFrameJSON(frame) << "\n";
            std::cout.flush();
        } else {
            std::cout << "Frame #" << fi
                      << " | detections=" << frame.detections.size()
                      << " | latency=" << std::fixed << std::setprecision(2)
                      << frame.processing_time_us << " µs"
                      << " | alpha=" << frame.alpha
                      << "\n";
            for (const auto& d : frame.detections) {
                std::cout << "  " << d.id
                          << " range=" << d.range_m << "m"
                          << " SNR=" << d.snr_db << "dB\n";
            }
        }
    }
    return 0;
}

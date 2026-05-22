#include "cfar/FFTProcessor.hpp"
#include <cmath>
#include <stdexcept>
#include <algorithm>

static constexpr float PI = 3.14159265358979323846f;

FFTProcessor::FFTProcessor(uint32_t fft_size, bool apply_hann)
    : fft_size_(fft_size), apply_hann_(apply_hann), plan_(nullptr),
      buf_in_(nullptr), buf_out_(nullptr)
{
    if (fft_size_ == 0 || (fft_size_ & (fft_size_ - 1)) != 0)
        throw std::invalid_argument("FFT size must be a power of 2");

    buf_in_  = fftwf_alloc_complex(fft_size_);
    buf_out_ = fftwf_alloc_complex(fft_size_);

    plan_ = fftwf_plan_dft_1d(
        static_cast<int>(fft_size_),
        buf_in_, buf_out_,
        FFTW_FORWARD, FFTW_ESTIMATE);

    if (apply_hann_) {
        hann_window_.resize(fft_size_);
        for (uint32_t n = 0; n < fft_size_; ++n)
            hann_window_[n] = 0.5f * (1.0f - std::cos(2.0f * PI * n / (fft_size_ - 1)));
    }
}

FFTProcessor::~FFTProcessor() {
    if (plan_)    fftwf_destroy_plan(plan_);
    if (buf_in_)  fftwf_free(buf_in_);
    if (buf_out_) fftwf_free(buf_out_);
}

std::vector<float> FFTProcessor::process(const float* iq_samples, uint32_t n_samples) const {
    const uint32_t n = std::min(n_samples / 2, fft_size_);

    for (uint32_t i = 0; i < fft_size_; ++i) {
        if (i < n) {
            float w = apply_hann_ ? hann_window_[i] : 1.0f;
            buf_in_[i][0] = iq_samples[2 * i]     * w;
            buf_in_[i][1] = iq_samples[2 * i + 1] * w;
        } else {
            buf_in_[i][0] = 0.0f;
            buf_in_[i][1] = 0.0f;
        }
    }

    fftwf_execute(plan_);

    const uint32_t out_size = fft_size_ / 2;
    std::vector<float> mag(out_size);
    const float inv_n = 1.0f / static_cast<float>(fft_size_);
    for (uint32_t k = 0; k < out_size; ++k) {
        float re = buf_out_[k][0] * inv_n;
        float im = buf_out_[k][1] * inv_n;
        mag[k] = std::sqrt(re * re + im * im);
    }
    return mag;
}

std::vector<float> FFTProcessor::computeDopplerMap(
    const std::vector<std::vector<float>>& chirp_profiles,
    uint32_t n_doppler_bins) const
{
    if (chirp_profiles.empty()) return {};
    const uint32_t n_range  = static_cast<uint32_t>(chirp_profiles[0].size());
    const uint32_t n_chirps = static_cast<uint32_t>(chirp_profiles.size());

    // Use 2*n_doppler_bins FFT so out_size = n_doppler_bins (FFT out_size = fft_size/2)
    FFTProcessor doppler_fft(n_doppler_bins * 2, true);

    std::vector<float> doppler_map(n_range * n_doppler_bins, 0.0f);
    std::vector<float> col_iq(n_doppler_bins * 2, 0.0f);

    for (uint32_t r = 0; r < n_range; ++r) {
        uint32_t fill = std::min(n_chirps, n_doppler_bins);
        for (uint32_t c = 0; c < n_doppler_bins * 2; ++c) col_iq[c] = 0.0f;
        for (uint32_t c = 0; c < fill; ++c) {
            col_iq[2 * c]     = chirp_profiles[c][r];
            col_iq[2 * c + 1] = 0.0f;
        }
        auto row = doppler_fft.process(col_iq.data(), n_doppler_bins * 2);
        for (uint32_t d = 0; d < n_doppler_bins; ++d)
            doppler_map[r * n_doppler_bins + d] = row[d];
    }

    // Normalize to [0,1]
    float mx = *std::max_element(doppler_map.begin(), doppler_map.end());
    if (mx > 0.0f)
        for (auto& v : doppler_map) v /= mx;

    return doppler_map;
}

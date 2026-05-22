#pragma once
#include <vector>
#include <fftw3.h>
#include "RangeProfile.hpp"

class FFTProcessor {
public:
    explicit FFTProcessor(uint32_t fft_size, bool apply_hann = true);
    ~FFTProcessor();

    FFTProcessor(const FFTProcessor&) = delete;
    FFTProcessor& operator=(const FFTProcessor&) = delete;

    // Process one chirp: interleaved IQ input → magnitude range profile (N/2 bins)
    std::vector<float> process(const float* iq_samples, uint32_t n_samples) const;

    // Process multiple chirps → Doppler map (flat: range × doppler)
    std::vector<float> computeDopplerMap(
        const std::vector<std::vector<float>>& chirp_profiles,
        uint32_t n_doppler_bins) const;

    uint32_t outputSize() const { return fft_size_ / 2; }

private:
    uint32_t fft_size_;
    bool     apply_hann_;
    std::vector<float> hann_window_;
    fftwf_plan      plan_;
    fftwf_complex*  buf_in_;   // allocated via fftwf_alloc_complex
    fftwf_complex*  buf_out_;
};

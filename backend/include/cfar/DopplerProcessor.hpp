#pragma once
#include "RangeProfile.hpp"
#include <vector>

class DopplerProcessor {
public:
    explicit DopplerProcessor(uint32_t n_range_bins, uint32_t n_doppler_bins);

    // Build 2D Doppler map from multiple chirp range profiles
    // chirp_profiles: each element is one chirp's range profile (n_range_bins values)
    // Returns flat array [n_range_bins × n_doppler_bins]
    std::vector<float> compute(
        const std::vector<std::vector<float>>& chirp_profiles) const;

    // Extract prominent targets from Doppler map
    std::vector<DopplerTarget> extractTargets(
        const std::vector<float>& doppler_map,
        uint32_t n_range_bins,
        float    threshold = 0.4f) const;

private:
    uint32_t n_range_bins_;
    uint32_t n_doppler_bins_;
};

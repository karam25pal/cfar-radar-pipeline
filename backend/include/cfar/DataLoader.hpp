#pragma once
#include "RangeProfile.hpp"
#include <vector>
#include <string>

class DataLoader {
public:
    // Generate synthetic FMCW IQ chirps for N_chirps chirps.
    // Returns: vector of N_chirps chirps, each chirp is 2*n_range_bins floats (IQ interleaved).
    static std::vector<std::vector<float>> generateSynthetic(
        const RadarConfig& config,
        uint32_t n_chirps = 64,
        uint32_t frame_index = 0);

    // Serialize RadarFrame to JSON string (no third-party library).
    static std::string saveFrameJSON(const RadarFrame& frame);
};

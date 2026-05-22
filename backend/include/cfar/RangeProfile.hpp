#pragma once
#include <vector>
#include <cstdint>
#include <string>

struct RadarConfig {
    float bandwidth_hz     = 4e9f;
    float chirp_duration_s = 40e-6f;
    float sample_rate_hz   = 10e6f;
    float center_freq_hz   = 77e9f;
    uint32_t n_range_bins    = 512;
    uint32_t n_doppler_bins  = 64;

    float range_resolution_m() const { return 3e8f / (2.0f * bandwidth_hz); }
    float max_range_m() const { return n_range_bins * range_resolution_m(); }
    float bin_to_range(uint32_t bin) const { return bin * range_resolution_m(); }
};

struct Detection {
    uint32_t range_bin;
    float    range_m;
    float    magnitude;
    float    threshold;
    float    snr_db;
    uint32_t doppler_bin;
    float    velocity_ms;
    std::string id;
};

struct DopplerTarget {
    uint32_t rb;
    uint32_t db;
    float    velocity;
    float    bin;
};

struct RadarFrame {
    uint32_t frame_index;
    int64_t  timestamp_ms;
    std::vector<float>       range_profile;
    std::vector<float>       cfar_threshold;
    std::vector<float>       doppler_map;
    std::vector<Detection>   detections;
    std::vector<DopplerTarget> doppler_targets;
    uint32_t doppler_rb;
    uint32_t doppler_dop;
    double   processing_time_us;
    float    alpha;
    float    range_step;
};

#include "cfar/DopplerProcessor.hpp"
#include "cfar/FFTProcessor.hpp"
#include <algorithm>
#include <cmath>

DopplerProcessor::DopplerProcessor(uint32_t n_range_bins, uint32_t n_doppler_bins)
    : n_range_bins_(n_range_bins), n_doppler_bins_(n_doppler_bins) {}

std::vector<float> DopplerProcessor::compute(
    const std::vector<std::vector<float>>& chirp_profiles) const
{
    if (chirp_profiles.empty()) return std::vector<float>(n_range_bins_ * n_doppler_bins_, 0.0f);

    FFTProcessor fft(n_doppler_bins_, true);
    return fft.computeDopplerMap(chirp_profiles, n_doppler_bins_);
}

std::vector<DopplerTarget> DopplerProcessor::extractTargets(
    const std::vector<float>& doppler_map,
    uint32_t n_range_bins,
    float    threshold) const
{
    std::vector<DopplerTarget> targets;
    const uint32_t DOP = n_doppler_bins_;

    for (uint32_t r = 1; r + 1 < n_range_bins; ++r) {
        for (uint32_t d = 1; d + 1 < DOP; ++d) {
            float v = doppler_map[r * DOP + d];
            if (v < threshold) continue;
            // local maximum check
            bool is_peak = true;
            for (int dr = -1; dr <= 1 && is_peak; ++dr) {
                for (int dd = -1; dd <= 1 && is_peak; ++dd) {
                    if (dr == 0 && dd == 0) continue;
                    uint32_t rr = r + dr, dd2 = d + dd;
                    if (rr < n_range_bins && dd2 < DOP)
                        if (doppler_map[rr * DOP + dd2] > v) is_peak = false;
                }
            }
            if (!is_peak) continue;

            DopplerTarget t;
            t.rb  = r;
            t.db  = d;
            t.velocity = (static_cast<float>(d) - static_cast<float>(DOP) / 2.0f)
                         * (60.0f / static_cast<float>(DOP));
            t.bin = static_cast<float>(r) / static_cast<float>(n_range_bins)
                    * static_cast<float>(n_range_bins_);
            targets.push_back(t);
        }
    }

    std::sort(targets.begin(), targets.end(),
              [&](const DopplerTarget& a, const DopplerTarget& b) {
                  return doppler_map[a.rb * DOP + a.db] > doppler_map[b.rb * DOP + b.db];
              });
    if (targets.size() > 8) targets.resize(8);
    return targets;
}

#include "cfar/CFARDetector.hpp"
#include <cmath>
#include <algorithm>
#include <stdexcept>

CFARDetector::CFARDetector(const Params& p) : params_(p) {
    alpha_ = computeAlpha(p.pfa, p.training_cells);
}

float CFARDetector::computeAlpha(float pfa, uint32_t n_training) {
    float N = static_cast<float>(2 * n_training);
    return N * (std::pow(pfa, -1.0f / N) - 1.0f);
}

std::vector<float> CFARDetector::computeThreshold(const std::vector<float>& profile) const {
    const int N = static_cast<int>(profile.size());
    const int G = static_cast<int>(params_.guard_cells);
    const int T = static_cast<int>(params_.training_cells);
    std::vector<float> threshold(N, 0.0f);

    for (int i = 0; i < N; i++) {
        float left_sum = 0.0f, right_sum = 0.0f;
        int   left_cnt = 0,   right_cnt = 0;

        for (int k = i - G - T; k < i - G; k++) {
            if (k >= 0 && k < N) { left_sum += profile[k]; ++left_cnt; }
        }
        for (int k = i + G + 1; k <= i + G + T; k++) {
            if (k >= 0 && k < N) { right_sum += profile[k]; ++right_cnt; }
        }

        float noise_est = 0.0f;
        if (params_.variant == Variant::GO) {
            float lm = left_cnt  ? left_sum  / left_cnt  : 0.0f;
            float rm = right_cnt ? right_sum / right_cnt : 0.0f;
            noise_est = std::max(lm, rm);
        } else {
            int total = left_cnt + right_cnt;
            noise_est = total ? (left_sum + right_sum) / total : 0.0f;
        }
        threshold[i] = alpha_ * noise_est;
    }
    return threshold;
}

std::vector<Detection> CFARDetector::detect(const std::vector<float>& profile,
                                              const std::vector<float>& threshold,
                                              const RadarConfig& config) const {
    const int N = static_cast<int>(profile.size());
    std::vector<Detection> dets;

    int i = 1;
    while (i < N - 1) {
        if (profile[i] > threshold[i]) {
            int start = i;
            while (i < N - 1 && profile[i] > threshold[i]) ++i;
            int end = i;

            int   best_idx = start;
            float best_val = profile[start];
            for (int k = start + 1; k < end; k++) {
                if (profile[k] > best_val) { best_val = profile[k]; best_idx = k; }
            }

            float thr = threshold[best_idx];
            float snr = 20.0f * std::log10(best_val / std::max(1e-6f, thr));
            if (snr > 1.0f) {
                Detection d;
                d.range_bin  = static_cast<uint32_t>(best_idx);
                d.range_m    = config.bin_to_range(d.range_bin);
                d.magnitude  = best_val;
                d.threshold  = thr;
                d.snr_db     = snr;
                d.doppler_bin = 0;
                d.velocity_ms = 0.0f;
                d.id         = "d" + std::to_string(best_idx);
                dets.push_back(d);
            }
        } else {
            ++i;
        }
    }

    std::sort(dets.begin(), dets.end(),
              [](const Detection& a, const Detection& b){ return a.magnitude > b.magnitude; });
    if (dets.size() > 8) dets.resize(8);
    return dets;
}

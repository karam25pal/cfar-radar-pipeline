#include <gtest/gtest.h>
#include "cfar/CFARDetector.hpp"
#include "cfar/DataLoader.hpp"
#include <cmath>
#include <random>
#include <sstream>

// 1. Alpha computation: Pfa=1e-4, N=32 → alpha ≈ 5.52
TEST(CFARTest, AlphaComputation) {
    float alpha = CFARDetector::computeAlpha(1e-4f, 16); // N = 2*16 = 32
    EXPECT_NEAR(alpha, 5.52f, 0.01f);
}

// 2. SingleTargetDetected: noise + one large spike → spike detected
TEST(CFARTest, SingleTargetDetected) {
    CFARDetector::Params p;
    p.guard_cells = 4; p.training_cells = 16; p.pfa = 1e-4f;
    p.variant = CFARDetector::Variant::CA;
    CFARDetector det(p);

    const int N = 512;
    std::vector<float> profile(N, 30.0f); // constant noise
    profile[200] = 30000.0f; // large spike

    auto threshold  = det.computeThreshold(profile);
    RadarConfig cfg; cfg.n_range_bins = N;
    auto detections = det.detect(profile, threshold, cfg);

    bool found = false;
    for (const auto& d : detections)
        if (d.range_bin == 200) { found = true; break; }
    EXPECT_TRUE(found);
}

// 3. FalseAlarmRate: 1000 noise-only profiles, FA rate ≤ 2 * Pfa * N
TEST(CFARTest, FalseAlarmRate) {
    CFARDetector::Params p;
    p.guard_cells = 4; p.training_cells = 16; p.pfa = 1e-4f;
    p.variant = CFARDetector::Variant::CA;
    CFARDetector det(p);

    const int N = 512;
    RadarConfig cfg; cfg.n_range_bins = N;
    std::mt19937 rng(123);
    std::exponential_distribution<float> dist(1.0f);

    int total_fa = 0;
    const int trials = 1000;
    for (int t = 0; t < trials; ++t) {
        std::vector<float> profile(N);
        for (auto& v : profile) v = dist(rng) * 30.0f;
        auto threshold  = det.computeThreshold(profile);
        auto detections = det.detect(profile, threshold, cfg);
        total_fa += static_cast<int>(detections.size());
    }

    double measured_far = static_cast<double>(total_fa) / (trials * N);
    EXPECT_LE(measured_far, 2.0 * p.pfa);
}

// 4. MultipleTargets: 3 targets at known bins → all 3 detected
TEST(CFARTest, MultipleTargets) {
    CFARDetector::Params p;
    p.guard_cells = 4; p.training_cells = 16; p.pfa = 1e-4f;
    p.variant = CFARDetector::Variant::CA;
    CFARDetector det(p);

    const int N = 512;
    std::vector<float> profile(N, 30.0f);
    int target_bins[] = {60, 200, 380};
    for (int bin : target_bins) profile[bin] = 20000.0f;

    auto threshold  = det.computeThreshold(profile);
    RadarConfig cfg; cfg.n_range_bins = N;
    auto detections = det.detect(profile, threshold, cfg);

    for (int bin : target_bins) {
        bool found = false;
        for (const auto& d : detections)
            if (static_cast<int>(d.range_bin) == bin) { found = true; break; }
        EXPECT_TRUE(found) << "Target at bin " << bin << " not detected";
    }
}

// 5. GOCFARMoreConservative: same profile → GO detections ≤ CA detections
TEST(CFARTest, GOCFARMoreConservative) {
    const int N = 512;
    std::vector<float> profile(N, 30.0f);
    profile[100] = 5000.0f;
    profile[300] = 3000.0f;

    RadarConfig cfg; cfg.n_range_bins = N;

    CFARDetector::Params pca;
    pca.guard_cells = 4; pca.training_cells = 16; pca.pfa = 1e-4f;
    pca.variant = CFARDetector::Variant::CA;
    CFARDetector ca(pca);

    CFARDetector::Params pgo = pca;
    pgo.variant = CFARDetector::Variant::GO;
    CFARDetector go(pgo);

    auto thr_ca = ca.computeThreshold(profile);
    auto thr_go = go.computeThreshold(profile);

    auto det_ca = ca.detect(profile, thr_ca, cfg);
    auto det_go = go.detect(profile, thr_go, cfg);

    EXPECT_LE(det_go.size(), det_ca.size());
}

// 6. JSONSerialisation: output has all required keys
TEST(CFARTest, JSONSerialisation) {
    RadarFrame frame;
    frame.frame_index = 42;
    frame.timestamp_ms = 1716000000000LL;
    frame.range_profile = {1.0f, 2.0f, 3.0f};
    frame.cfar_threshold = {0.5f, 0.6f, 0.7f};
    frame.doppler_map = {0.1f, 0.2f};
    frame.doppler_rb = 64; frame.doppler_dop = 64;
    frame.processing_time_us = 0.34;
    frame.alpha = 5.52f;
    frame.range_step = 0.976f;

    Detection d; d.range_bin = 52; d.range_m = 49.8f;
    d.magnitude = 1842.3f; d.threshold = 312.4f; d.snr_db = 18.4f; d.id = "d52";
    frame.detections.push_back(d);

    std::string json = DataLoader::saveFrameJSON(frame);

    EXPECT_NE(json.find("\"frameIndex\""),     std::string::npos);
    EXPECT_NE(json.find("\"rangeProfile\""),   std::string::npos);
    EXPECT_NE(json.find("\"cfarThreshold\""),  std::string::npos);
    EXPECT_NE(json.find("\"dopplerMap\""),     std::string::npos);
    EXPECT_NE(json.find("\"dopplerSize\""),    std::string::npos);
    EXPECT_NE(json.find("\"dopplerTargets\""), std::string::npos);
    EXPECT_NE(json.find("\"detections\""),     std::string::npos);
    EXPECT_NE(json.find("\"processingTimeUs\""), std::string::npos);
    EXPECT_NE(json.find("\"alpha\""),          std::string::npos);
    EXPECT_NE(json.find("\"rangeStep\""),      std::string::npos);
    EXPECT_NE(json.find("\"d52\""),            std::string::npos);
}

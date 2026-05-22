#include "cfar/CFARDetector.hpp"
#include "cfar/FFTProcessor.hpp"
#include "cfar/DataLoader.hpp"
#include "cfar/BenchmarkTimer.hpp"
#include <iostream>
#include <vector>
#include <algorithm>
#include <numeric>

int main() {
    RadarConfig config;
    config.n_range_bins = 512;

    CFARDetector::Params p;
    p.guard_cells = 4; p.training_cells = 16; p.pfa = 1e-4f;
    p.variant = CFARDetector::Variant::CA;
    CFARDetector det(p);
    FFTProcessor  fft(1024);

    const uint32_t ITERS = 10000;
    std::vector<double> latencies;
    latencies.reserve(ITERS);

    for (uint32_t i = 0; i < ITERS; ++i) {
        auto chirps  = DataLoader::generateSynthetic(config, 1, i);
        auto profile = fft.process(chirps[0].data(), static_cast<uint32_t>(chirps[0].size()));

        BenchmarkTimer t; t.start();
        auto thresh = det.computeThreshold(profile);
        det.detect(profile, thresh, config);
        latencies.push_back(t.stopUs());
    }

    std::sort(latencies.begin(), latencies.end());
    double mean_us  = std::accumulate(latencies.begin(), latencies.end(), 0.0) / ITERS;
    double min_us   = latencies.front();
    double p99_us   = latencies[static_cast<size_t>(ITERS * 0.99)];
    double throughput = mean_us > 0.0 ? 1e6 / mean_us : 0.0;

    std::cout << "Mean: " << mean_us << " µs | Min: " << min_us
              << " µs | P99: " << p99_us << " µs | Throughput: "
              << throughput << " fps\n";
    return 0;
}

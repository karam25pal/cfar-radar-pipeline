#include <gtest/gtest.h>
#include "cfar/FFTProcessor.hpp"
#include <cmath>
#include <vector>

// Zero input → zero output
TEST(FFTTest, ZeroInput) {
    FFTProcessor fft(256);
    std::vector<float> iq(512, 0.0f);
    auto mag = fft.process(iq.data(), 512);
    ASSERT_EQ(mag.size(), 128u);
    for (float v : mag) EXPECT_NEAR(v, 0.0f, 1e-6f);
}

// Known DC tone: constant real, zero imag → peak at bin 0
TEST(FFTTest, DcTone) {
    FFTProcessor fft(256, false); // no Hann for exact check
    std::vector<float> iq(512, 0.0f);
    for (int i = 0; i < 256; ++i) iq[2 * i] = 1.0f; // real=1, imag=0
    auto mag = fft.process(iq.data(), 512);
    ASSERT_EQ(mag.size(), 128u);
    // DC bin should be largest
    float dc = mag[0];
    for (size_t k = 1; k < mag.size(); ++k)
        EXPECT_LE(mag[k], dc + 1e-4f) << "bin " << k << " exceeds DC";
}

// Output size is always fft_size/2
TEST(FFTTest, OutputSize) {
    for (uint32_t sz : {128u, 256u, 512u, 1024u}) {
        FFTProcessor fft(sz);
        std::vector<float> iq(sz * 2, 0.0f);
        auto mag = fft.process(iq.data(), sz * 2);
        EXPECT_EQ(mag.size(), sz / 2);
    }
}

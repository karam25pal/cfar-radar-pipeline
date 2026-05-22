#pragma once
#include "RangeProfile.hpp"

class CFARDetector {
public:
    enum class Variant { CA, GO };

    struct Params {
        uint32_t guard_cells    = 4;
        uint32_t training_cells = 16;
        float    pfa            = 1e-4f;
        Variant  variant        = Variant::CA;
    };

    explicit CFARDetector(const Params& p);

    std::vector<Detection> detect(const std::vector<float>& profile,
                                   const std::vector<float>& threshold,
                                   const RadarConfig& config) const;

    std::vector<float> computeThreshold(const std::vector<float>& profile) const;

    static float computeAlpha(float pfa, uint32_t n_training);

    float alpha() const { return alpha_; }

private:
    Params params_;
    float  alpha_;
};

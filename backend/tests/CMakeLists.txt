find_package(GTest REQUIRED)

add_executable(test_cfar test_cfar.cpp test_fft.cpp)
target_link_libraries(test_cfar PRIVATE cfar_lib GTest::GTest GTest::Main)

include(GoogleTest)
gtest_discover_tests(test_cfar)

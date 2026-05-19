#include "bysykkel_score.h"

#include <stdio.h>

static int failures = 0;

static void expect_range(const char *name, float value, float min, float max) {
  if (value < min || value > max) {
    printf("FAIL %s: got %.2f, expected %.2f..%.2f\n", name, value, min, max);
    failures += 1;
    return;
  }

  printf("PASS %s: %.2f\n", name, value);
}

static void expect_int(const char *name, int value, int expected) {
  if (value != expected) {
    printf("FAIL %s: got %d, expected %d\n", name, value, expected);
    failures += 1;
    return;
  }

  printf("PASS %s: %d\n", name, value);
}

int main(void) {
  // Long trip (~4 km): Q saturates at ~1, so score ≈ availability × 100.
  float long_trip = bysykkel_score_trip(250.0f, 4000.0f, 200.0f, 8, 9, 20, 24, 1, 1);
  expect_range("long trip score", long_trip, 90.0f, 100.0f);
  expect_int("long trip confidence", bysykkel_confidence_band(long_trip), BYSYKKEL_CONFIDENCE_HIGH);

  // Medium trip (~1.5 km): Q ≈ 0.44, score is moderate even with full availability.
  float medium_trip = bysykkel_score_trip(250.0f, 1500.0f, 200.0f, 8, 9, 20, 24, 1, 1);
  expect_range("medium trip score", medium_trip, 35.0f, 55.0f);

  // Short trip (< 500 m): Q is near zero, score gets dragged down even with full availability.
  float short_trip = bysykkel_score_trip(150.0f, 400.0f, 100.0f, 8, 9, 20, 24, 1, 1);
  expect_range("short trip dragged down", short_trip, 0.0f, 8.0f);

  // Zero bikes / docks / closed pickup → score = 0 regardless of Q.
  float no_bikes = bysykkel_score_trip(150.0f, 1500.0f, 150.0f, 0, 8, 20, 24, 1, 1);
  expect_range("no bikes", no_bikes, 0.0f, 0.0f);

  float no_docks = bysykkel_score_trip(150.0f, 1500.0f, 150.0f, 8, 0, 20, 24, 1, 1);
  expect_range("no docks", no_docks, 0.0f, 0.0f);

  float closed_pickup = bysykkel_score_trip(150.0f, 1500.0f, 150.0f, 8, 8, 20, 24, 0, 1);
  expect_range("closed pickup", closed_pickup, 0.0f, 0.0f);

  // Zero bikes still 0 even on a long trip (availability gate dominates).
  float no_bikes_long = bysykkel_score_trip(150.0f, 4000.0f, 150.0f, 0, 8, 20, 24, 1, 1);
  expect_range("no bikes on long trip", no_bikes_long, 0.0f, 0.0f);

  // Monotonic in availability: same trip, more bikes → higher score.
  float low_avail = bysykkel_score_trip(250.0f, 2000.0f, 200.0f, 1, 9, 20, 24, 1, 1);
  float high_avail = bysykkel_score_trip(250.0f, 2000.0f, 200.0f, 9, 9, 20, 24, 1, 1);
  if (high_avail <= low_avail) {
    printf("FAIL monotonic availability: low %.2f, high %.2f\n", low_avail, high_avail);
    failures += 1;
  } else {
    printf("PASS monotonic availability: low %.2f, high %.2f\n", low_avail, high_avail);
  }

  // Monotonic in trip quality: same availability, longer ride (still in linear range) → higher score.
  float short_q = bysykkel_score_trip(250.0f, 800.0f, 200.0f, 8, 9, 20, 24, 1, 1);
  float long_q = bysykkel_score_trip(250.0f, 2500.0f, 200.0f, 8, 9, 20, 24, 1, 1);
  if (long_q <= short_q) {
    printf("FAIL monotonic quality: short %.2f, long %.2f\n", short_q, long_q);
    failures += 1;
  } else {
    printf("PASS monotonic quality: short %.2f, long %.2f\n", short_q, long_q);
  }

  // Reasonable nearby vs further station: a closer-but-empty station should
  // still rank below a slightly further one with bikes when the trip is the same length.
  float nearby_risky = bysykkel_score_trip(80.0f, 1500.0f, 80.0f, 1, 1, 20, 24, 1, 1);
  float farther_safe = bysykkel_score_trip(550.0f, 1700.0f, 450.0f, 7, 8, 20, 24, 1, 1);
  if (farther_safe <= nearby_risky) {
    printf("FAIL safer alternative: risky %.2f, safe %.2f\n", nearby_risky, farther_safe);
    failures += 1;
  } else {
    printf("PASS safer alternative: risky %.2f, safe %.2f\n", nearby_risky, farther_safe);
  }

  // Direct trip-quality bounds.
  float q_very_short = bysykkel_trip_quality(100.0f, 200.0f, 100.0f);
  expect_range("Q very short ride", q_very_short, 0.0f, 0.05f);

  float q_long = bysykkel_trip_quality(150.0f, 4000.0f, 150.0f);
  expect_range("Q long ride", q_long, 0.95f, 1.0f);

  float q_medium = bysykkel_trip_quality(200.0f, 1500.0f, 200.0f);
  expect_range("Q medium ride", q_medium, 0.40f, 0.50f);

  // Walk-detour penalty kicks in: same ride, but walking far to/from stations drops Q.
  float q_walk_heavy = bysykkel_trip_quality(1600.0f, 1600.0f, 200.0f);
  expect_range("Q walk-heavy", q_walk_heavy, 0.15f, 0.35f);

  return failures == 0 ? 0 : 1;
}

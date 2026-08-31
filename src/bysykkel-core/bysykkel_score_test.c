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
  // ---- feasibility: a station pair is usable, or it is not ----

  expect_int("bikes and docks available", bysykkel_trip_feasible(3, 5, 1, 1, 1, 1), 1);
  expect_int("exactly one bike, one lock", bysykkel_trip_feasible(1, 1, 1, 1, 1, 1), 1);
  expect_int("no bikes", bysykkel_trip_feasible(0, 5, 1, 1, 1, 1), 0);
  expect_int("no free locks", bysykkel_trip_feasible(3, 0, 1, 1, 1, 1), 0);
  expect_int("pickup not renting", bysykkel_trip_feasible(9, 9, 0, 1, 1, 1), 0);
  expect_int("dropoff not returning", bysykkel_trip_feasible(9, 9, 1, 0, 1, 1), 0);

  // A caller can demand a safety buffer instead of the bare minimum.
  expect_int("2 bikes vs buffer of 3", bysykkel_trip_feasible(2, 9, 1, 1, 3, 1), 0);
  expect_int("4 bikes vs buffer of 3", bysykkel_trip_feasible(4, 9, 1, 1, 3, 1), 1);
  expect_int("1 lock vs buffer of 2", bysykkel_trip_feasible(9, 1, 1, 1, 1, 2), 0);

  // A nonsensical threshold is clamped up to 1, never down to "anything goes":
  // zero bikes must never read as feasible.
  expect_int("zero threshold still needs a bike", bysykkel_trip_feasible(0, 5, 1, 1, 0, 0), 0);

  // ---- door-to-door time: the only thing the planner ranks on ----

  // 400 m walk (5 min) + 2300 m ride (10 min) + 160 m walk (2 min) + 1.5 handling.
  expect_range("typical trip minutes", bysykkel_trip_minutes(400.0f, 2300.0f, 160.0f), 18.4f, 18.6f);

  // Handling overhead is charged even when the ride is trivial.
  expect_range("handling overhead", bysykkel_trip_minutes(0.0f, 0.0f, 0.0f), 1.5f, 1.5f);

  // Walking is 80 m/min flat.
  expect_range("direct walk minutes", bysykkel_walk_minutes(800.0f), 9.9f, 10.1f);

  // Negative inputs are rejected rather than silently producing a fast trip.
  expect_range("negative ride rejected", bysykkel_trip_minutes(100.0f, -1.0f, 100.0f), -1.0f, -1.0f);
  expect_range("negative walk rejected", bysykkel_walk_minutes(-1.0f), -1.0f, -1.0f);

  // ---- the two properties the ranking depends on ----

  // Monotonic in every leg: adding metres to any leg can only make a trip slower.
  float base = bysykkel_trip_minutes(300.0f, 1500.0f, 200.0f);
  if (bysykkel_trip_minutes(600.0f, 1500.0f, 200.0f) <= base
      || bysykkel_trip_minutes(300.0f, 2500.0f, 200.0f) <= base
      || bysykkel_trip_minutes(300.0f, 1500.0f, 500.0f) <= base) {
    printf("FAIL monotonic in distance: base %.2f\n", base);
    failures += 1;
  } else {
    printf("PASS monotonic in distance: base %.2f\n", base);
  }

  // A closer rack wins when the ride is the same — the case the old blended
  // score got wrong, and the reason the model was replaced.
  float near_rack = bysykkel_trip_minutes(120.0f, 2000.0f, 200.0f);
  float far_rack = bysykkel_trip_minutes(800.0f, 2000.0f, 200.0f);
  if (near_rack >= far_rack) {
    printf("FAIL closer rack wins: near %.2f, far %.2f\n", near_rack, far_rack);
    failures += 1;
  } else {
    printf("PASS closer rack wins: near %.2f, far %.2f\n", near_rack, far_rack);
  }

  // Short hop: walking the whole way beats fetching a bike, and the app is
  // expected to say so rather than recommend a pointless ride.
  float short_hop_bike = bysykkel_trip_minutes(250.0f, 400.0f, 150.0f);
  float short_hop_walk = bysykkel_walk_minutes(500.0f);
  if (short_hop_walk >= short_hop_bike) {
    printf("FAIL walk beats bike on short hop: bike %.2f, walk %.2f\n", short_hop_bike, short_hop_walk);
    failures += 1;
  } else {
    printf("PASS walk beats bike on short hop: bike %.2f, walk %.2f\n", short_hop_bike, short_hop_walk);
  }

  // Long haul: the bike is clearly worth it.
  float long_haul_bike = bysykkel_trip_minutes(250.0f, 4000.0f, 200.0f);
  float long_haul_walk = bysykkel_walk_minutes(3800.0f);
  if (long_haul_bike >= long_haul_walk) {
    printf("FAIL bike beats walk on long haul: bike %.2f, walk %.2f\n", long_haul_bike, long_haul_walk);
    failures += 1;
  } else {
    printf("PASS bike beats walk on long haul: bike %.2f, walk %.2f\n", long_haul_bike, long_haul_walk);
  }

  return failures == 0 ? 0 : 1;
}

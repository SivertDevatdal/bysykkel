#include "bysykkel_score.h"

static float clampf(float value, float min, float max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

static float availability_score(int available, int capacity) {
  if (available <= 0 || capacity <= 0) {
    return 0.0f;
  }

  float count_score = clampf((float)available / 4.0f, 0.0f, 1.0f);
  float ratio_score = clampf(((float)available / (float)capacity) / 0.35f, 0.0f, 1.0f);

  return (count_score * 0.7f) + (ratio_score * 0.3f);
}

// Trip quality Q in [0, 1]: how worthwhile is biking from this pickup, given
// the trip distance and the walk overhead, vs walking or scootering directly.
//
// Reference speeds (km/h): walk=5, scooter=20, bike=25 (commuter pace; fit
// riders can sustain ~40 but we treat that as an upper bound, not the default).
//
// Shape:
//   - base scales linearly in ride distance, 0 at 300 m and saturates at 1.0
//     at 3 km. Below ~300 m, walking is essentially as fast in practice and
//     a scooter would beat a bike trip-overhead-wise, so Q approaches 0.
//   - a walk-detour penalty kicks in once total walk to/from stations exceeds
//     ~600 m, capped at a 60% reduction so a long detour can't fully zero out
//     a long ride.
//
// Inputs are expected to be non-negative; the score_trip caller already guards.
float bysykkel_trip_quality(
  float walk_to_pickup_m,
  float ride_m,
  float walk_from_dropoff_m
) {
  if (ride_m <= 0.0f) {
    return 0.0f;
  }

  float base = clampf((ride_m - 300.0f) / 2700.0f, 0.0f, 1.0f);

  float walk_total = walk_to_pickup_m + walk_from_dropoff_m;
  float walk_excess = walk_total - 600.0f;
  if (walk_excess < 0.0f) {
    walk_excess = 0.0f;
  }
  float walk_penalty = clampf(walk_excess / 2400.0f, 0.0f, 0.6f);

  return base * (1.0f - walk_penalty);
}

// Final score = availability × trip quality (× 100), so a station with bikes
// only ranks high when biking from it is also a meaningful upgrade over
// walking. Availability is the joint pickup/dropoff feasibility at the
// requested trip; Q is the speed-advantage utility.
float bysykkel_score_trip(
  float walk_to_pickup_m,
  float ride_m,
  float walk_from_dropoff_m,
  int bikes_available,
  int docks_available,
  int pickup_capacity,
  int dropoff_capacity,
  int pickup_is_renting,
  int dropoff_is_returning
) {
  if (
    walk_to_pickup_m < 0.0f
    || ride_m < 0.0f
    || walk_from_dropoff_m < 0.0f
    || pickup_is_renting == 0
    || dropoff_is_returning == 0
  ) {
    return 0.0f;
  }

  float pickup = availability_score(bikes_available, pickup_capacity);
  float dropoff = availability_score(docks_available, dropoff_capacity);
  if (pickup == 0.0f || dropoff == 0.0f) {
    return 0.0f;
  }

  float availability = (pickup * 0.5f) + (dropoff * 0.5f);
  float quality = bysykkel_trip_quality(walk_to_pickup_m, ride_m, walk_from_dropoff_m);

  return clampf(availability * quality * 100.0f, 0.0f, 100.0f);
}

int bysykkel_confidence_band(float score) {
  if (score >= 75.0f) {
    return BYSYKKEL_CONFIDENCE_HIGH;
  }
  if (score >= 45.0f) {
    return BYSYKKEL_CONFIDENCE_MEDIUM;
  }
  return BYSYKKEL_CONFIDENCE_LOW;
}

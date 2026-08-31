#include "bysykkel_score.h"

// The planner is deliberately black and white.
//
// It used to blend a Poisson availability forecast with a "trip quality"
// utility term and rank on the product. That produced suggestions nobody
// could explain — a rack with five bikes 100 m away losing to one 800 m away
// because the longer ride scored better on quality. Every knob in that model
// was a place for the ranking to go wrong in a way the UI could not show.
//
// What replaced it: a station is either usable or it is not (it has the bikes
// / locks the feed reports, and it is renting / returning), and among the
// usable ones the fastest door-to-door trip wins. Two rules, both checkable
// against what the app puts on screen.

int bysykkel_trip_feasible(
  int bikes_available,
  int docks_available,
  int pickup_is_renting,
  int dropoff_is_returning,
  int min_bikes,
  int min_docks
) {
  if (pickup_is_renting == 0 || dropoff_is_returning == 0) {
    return 0;
  }
  if (min_bikes < 1) {
    min_bikes = 1;
  }
  if (min_docks < 1) {
    min_docks = 1;
  }
  if (bikes_available < min_bikes || docks_available < min_docks) {
    return 0;
  }
  return 1;
}

float bysykkel_trip_minutes(
  float walk_to_pickup_m,
  float ride_m,
  float walk_from_dropoff_m
) {
  if (walk_to_pickup_m < 0.0f || ride_m < 0.0f || walk_from_dropoff_m < 0.0f) {
    return -1.0f;
  }

  float walk_m = walk_to_pickup_m + walk_from_dropoff_m;
  return (walk_m / BYSYKKEL_WALK_M_PER_MIN)
    + (ride_m / BYSYKKEL_RIDE_M_PER_MIN)
    + BYSYKKEL_HANDLING_MIN;
}

float bysykkel_walk_minutes(float direct_m) {
  if (direct_m < 0.0f) {
    return -1.0f;
  }
  return direct_m / BYSYKKEL_WALK_M_PER_MIN;
}

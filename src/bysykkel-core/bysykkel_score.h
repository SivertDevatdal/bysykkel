#ifndef BYSYKKEL_SCORE_H
#define BYSYKKEL_SCORE_H

#ifdef __cplusplus
extern "C" {
#endif

enum BysykkelConfidence {
  BYSYKKEL_CONFIDENCE_LOW = 0,
  BYSYKKEL_CONFIDENCE_MEDIUM = 1,
  BYSYKKEL_CONFIDENCE_HIGH = 2,
};

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
);

float bysykkel_trip_quality(
  float walk_to_pickup_m,
  float ride_m,
  float walk_from_dropoff_m
);

int bysykkel_confidence_band(float score);

#ifdef __cplusplus
}
#endif

#endif

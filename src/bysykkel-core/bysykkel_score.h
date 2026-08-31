#ifndef BYSYKKEL_SCORE_H
#define BYSYKKEL_SCORE_H

#ifdef __cplusplus
extern "C" {
#endif

// Fixed speeds and overheads for the door-to-door time model. These are the
// only tunables in the whole planner: everything the app ranks is derived
// from them, so a route that looks wrong can always be traced back here.
//
//   walk  80 m/min  ≈ 4.8 km/h  (unhurried city walking)
//   ride 230 m/min  ≈ 13.8 km/h (a heavy city bike in traffic, with lights)
//   handling 1.5 min             (unlock at the rack + dock and confirm)
#define BYSYKKEL_WALK_M_PER_MIN 80.0f
#define BYSYKKEL_RIDE_M_PER_MIN 230.0f
#define BYSYKKEL_HANDLING_MIN 1.5f

// Can this station pair actually serve the trip *right now*? No forecasting,
// no probabilities — just the counts the live feed reports this second.
int bysykkel_trip_feasible(
  int bikes_available,
  int docks_available,
  int pickup_is_renting,
  int dropoff_is_returning,
  int min_bikes,
  int min_docks
);

// Door-to-door minutes: walk to the rack, ride, walk from the rack, plus the
// fixed handling overhead. This is the number the planner sorts on.
float bysykkel_trip_minutes(
  float walk_to_pickup_m,
  float ride_m,
  float walk_from_dropoff_m
);

// Minutes to just walk the whole way. If this beats the best bike trip, the
// honest answer is "walk" — and the app says so.
float bysykkel_walk_minutes(float direct_m);

#ifdef __cplusplus
}
#endif

#endif

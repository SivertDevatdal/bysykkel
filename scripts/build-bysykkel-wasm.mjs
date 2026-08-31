import wabtFactory from "wabt";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const outputDir = "app/bysykkel/public";
const outputFile = `${outputDir}/bysykkel_score.wasm`;

const clangArgs = [
  "--target=wasm32-unknown-unknown",
  "-O3",
  "-nostdlib",
  "-Wl,--no-entry",
  "-Wl,--export=bysykkel_trip_feasible",
  "-Wl,--export=bysykkel_trip_minutes",
  "-Wl,--export=bysykkel_walk_minutes",
  "-Wl,--allow-undefined",
  "src/bysykkel-core/bysykkel_score.c",
  "-o",
  outputFile,
];

async function main() {
  await mkdir(outputDir, { recursive: true });

  if (await run("clang", clangArgs)) {
    console.log(`Built ${outputFile} from C`);
  } else {
    await buildWatFallback();
    console.log(`Built ${outputFile} from WAT fallback`);
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout.on("data", () => {});

    child.on("error", () => {
      resolve(false);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }

      const reason = stderr.trim().split("\n")[0] ?? "unknown compiler error";
      console.warn(`clang could not build WASM (${reason}); using WAT fallback.`);
      resolve(false);
    });
  });
}

async function buildWatFallback() {
  const wabt = await wabtFactory();
  const module = wabt.parseWat("bysykkel_score.wat", bysykkelScoreWat);
  const binary = module.toBinary({ log: false, write_debug_names: true });
  await writeFile(outputFile, Buffer.from(binary.buffer));
}

const bysykkelScoreWat = String.raw`
(module
  ;; Hand-written mirror of src/bysykkel-core/bysykkel_score.c, used only when
  ;; clang is unavailable. Keep the constants below in sync with
  ;; bysykkel_score.h — the failtest compares both builds against the same
  ;; expectations, so a drift here shows up as a failing time assertion.
  ;;   walk 80 m/min, ride 230 m/min, handling 1.5 min

  (func $bysykkel_trip_feasible
    (param $bikes i32) (param $docks i32)
    (param $is_renting i32) (param $is_returning i32)
    (param $min_bikes i32) (param $min_docks i32)
    (result i32)
    (local $need_bikes i32)
    (local $need_docks i32)

    local.get $is_renting
    i32.eqz
    if
      i32.const 0
      return
    end

    local.get $is_returning
    i32.eqz
    if
      i32.const 0
      return
    end

    ;; need = max(min, 1)
    local.get $min_bikes
    i32.const 1
    i32.lt_s
    if (result i32)
      i32.const 1
    else
      local.get $min_bikes
    end
    local.set $need_bikes

    local.get $min_docks
    i32.const 1
    i32.lt_s
    if (result i32)
      i32.const 1
    else
      local.get $min_docks
    end
    local.set $need_docks

    local.get $bikes
    local.get $need_bikes
    i32.lt_s
    if
      i32.const 0
      return
    end

    local.get $docks
    local.get $need_docks
    i32.lt_s
    if
      i32.const 0
      return
    end

    i32.const 1
  )

  (func $bysykkel_trip_minutes
    (param $walk_to_pickup_m f32) (param $ride_m f32) (param $walk_from_dropoff_m f32)
    (result f32)

    local.get $walk_to_pickup_m
    f32.const 0
    f32.lt
    local.get $ride_m
    f32.const 0
    f32.lt
    i32.or
    local.get $walk_from_dropoff_m
    f32.const 0
    f32.lt
    i32.or
    if
      f32.const -1
      return
    end

    local.get $walk_to_pickup_m
    local.get $walk_from_dropoff_m
    f32.add
    f32.const 80
    f32.div

    local.get $ride_m
    f32.const 230
    f32.div
    f32.add

    f32.const 1.5
    f32.add
  )

  (func $bysykkel_walk_minutes (param $direct_m f32) (result f32)
    local.get $direct_m
    f32.const 0
    f32.lt
    if
      f32.const -1
      return
    end

    local.get $direct_m
    f32.const 80
    f32.div
  )

  (export "bysykkel_trip_feasible" (func $bysykkel_trip_feasible))
  (export "bysykkel_trip_minutes" (func $bysykkel_trip_minutes))
  (export "bysykkel_walk_minutes" (func $bysykkel_walk_minutes))
)
`;

await main();

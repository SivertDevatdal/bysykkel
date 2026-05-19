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
  "-Wl,--export=bysykkel_score_trip",
  "-Wl,--export=bysykkel_trip_quality",
  "-Wl,--export=bysykkel_confidence_band",
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
  (func $clampf (param $value f32) (param $min f32) (param $max f32) (result f32)
    local.get $value
    local.get $min
    f32.lt
    if (result f32)
      local.get $min
    else
      local.get $value
      local.get $max
      f32.gt
      if (result f32)
        local.get $max
      else
        local.get $value
      end
    end
  )

  (func $availability_score (param $available i32) (param $capacity i32) (result f32)
    local.get $available
    i32.const 0
    i32.le_s
    local.get $capacity
    i32.const 0
    i32.le_s
    i32.or
    if (result f32)
      f32.const 0
    else
      local.get $available
      f32.convert_i32_s
      f32.const 4
      f32.div
      f32.const 0
      f32.const 1
      call $clampf
      f32.const 0.7
      f32.mul

      local.get $available
      f32.convert_i32_s
      local.get $capacity
      f32.convert_i32_s
      f32.div
      f32.const 0.35
      f32.div
      f32.const 0
      f32.const 1
      call $clampf
      f32.const 0.3
      f32.mul
      f32.add
    end
  )

  (func $bysykkel_trip_quality
    (export "bysykkel_trip_quality")
    (param $walk_to_pickup_m f32)
    (param $ride_m f32)
    (param $walk_from_dropoff_m f32)
    (result f32)
    (local $base f32)
    (local $walk_total f32)
    (local $walk_excess f32)
    (local $walk_penalty f32)

    local.get $ride_m
    f32.const 0
    f32.le
    if (result f32)
      f32.const 0
    else
      local.get $ride_m
      f32.const 300
      f32.sub
      f32.const 2700
      f32.div
      f32.const 0
      f32.const 1
      call $clampf
      local.set $base

      local.get $walk_to_pickup_m
      local.get $walk_from_dropoff_m
      f32.add
      local.set $walk_total

      local.get $walk_total
      f32.const 600
      f32.sub
      local.set $walk_excess

      local.get $walk_excess
      f32.const 0
      f32.lt
      if
        f32.const 0
        local.set $walk_excess
      end

      local.get $walk_excess
      f32.const 2400
      f32.div
      f32.const 0
      f32.const 0.6
      call $clampf
      local.set $walk_penalty

      local.get $base
      f32.const 1
      local.get $walk_penalty
      f32.sub
      f32.mul
    end
  )

  (func $bysykkel_score_trip
    (export "bysykkel_score_trip")
    (param $walk_to_pickup_m f32)
    (param $ride_m f32)
    (param $walk_from_dropoff_m f32)
    (param $bikes_available i32)
    (param $docks_available i32)
    (param $pickup_capacity i32)
    (param $dropoff_capacity i32)
    (param $pickup_is_renting i32)
    (param $dropoff_is_returning i32)
    (result f32)
    (local $pickup f32)
    (local $dropoff f32)
    (local $availability f32)
    (local $quality f32)

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
    local.get $pickup_is_renting
    i32.const 0
    i32.eq
    i32.or
    local.get $dropoff_is_returning
    i32.const 0
    i32.eq
    i32.or
    if (result f32)
      f32.const 0
    else
      local.get $bikes_available
      local.get $pickup_capacity
      call $availability_score
      local.set $pickup

      local.get $docks_available
      local.get $dropoff_capacity
      call $availability_score
      local.set $dropoff

      local.get $pickup
      f32.const 0
      f32.eq
      local.get $dropoff
      f32.const 0
      f32.eq
      i32.or
      if (result f32)
        f32.const 0
      else
        local.get $pickup
        f32.const 0.5
        f32.mul
        local.get $dropoff
        f32.const 0.5
        f32.mul
        f32.add
        local.set $availability

        local.get $walk_to_pickup_m
        local.get $ride_m
        local.get $walk_from_dropoff_m
        call $bysykkel_trip_quality
        local.set $quality

        local.get $availability
        local.get $quality
        f32.mul
        f32.const 100
        f32.mul
        f32.const 0
        f32.const 100
        call $clampf
      end
    end
  )

  (func $bysykkel_confidence_band
    (export "bysykkel_confidence_band")
    (param $score f32)
    (result i32)
    local.get $score
    f32.const 75
    f32.ge
    if (result i32)
      i32.const 2
    else
      local.get $score
      f32.const 45
      f32.ge
      if (result i32)
        i32.const 1
      else
        i32.const 0
      end
    end
  )
)
`;

await main();

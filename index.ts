#!/usr/bin/env -S npx tsx

import { copyFile } from "copy-file";
import ffmpeg from "fluent-ffmpeg";
import type { Stats } from "fs";
import inquirer from "inquirer";
import Multiprogress from "multi-progress";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";

const getDuration = (target: string): Promise<number> =>
  new Promise((resolve, reject) =>
    execFile(
      "ffprobe",
      ["-i", target, "-print_format", "json", "-show_format"],
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") {
            reject(err);
          } else {
            reject(new Error(stderr));
          }
        } else {
          resolve(Number(JSON.parse(stdout).format.duration));
        }
      }
    )
  );

function timemarkToSeconds(timemark: string) {
  if (typeof timemark === "number") return timemark;

  if (!timemark.includes(":") && timemark.indexOf(".") >= 0) {
    return Number(timemark);
  }

  var parts = timemark.split(":");

  // add seconds
  var secs = Number(parts.pop());

  if (parts.length) {
    // add minutes
    secs += Number(parts.pop()) * 60;
  }

  if (parts.length) {
    // add hours
    secs += Number(parts.pop()) * 3600;
  }

  return secs;
}

function secondsToTimemark(seconds: number) {
  const pad = (num: number) => (num < 10 ? `0${num}` : num);

  const H = pad(Math.floor(seconds / 3600));
  const i = pad(Math.floor((seconds % 3600) / 60));
  const s = pad(seconds % 60);

  return `${H}:${i}:${s}`;
}

async function getDeviceNameFromFile(videoPath: string): Promise<string> {
  const regexDeviceName = new Promise<string>((resolve, reject) => {
    const ffmpegCommand = ffmpeg(videoPath)
      .outputOption("-y")
      .outputOptions("-codec copy")
      // Stream 3 is the GPMF stream
      .outputOptions(`-map 0:3`)
      .outputOption("-f rawvideo")
      .on("error", reject);

    return ffmpegCommand
      .pipe()
      .on("data", (chunk) => {
        const deviceName = chunk
          .toString("utf8")
          .match(/DVNMc(.+)STRM/u)?.[1]
          ?.replace(/[^a-zA-Z0-9]/g, "");
        if (deviceName) {
          ffmpegCommand.kill("SIGKILL");
          resolve(deviceName);
        }
      })
      .on("end", () => reject("Failed to get the camera name"));
  });
  return regexDeviceName || "Unknown Device";
}

const sessionName = `2025-08-07-Exelerate-HftH-Single-Guitar-Solos`;
const destinationFolder = `/Volumes/@klarstrup2/${sessionName}`;

const allVolumes = await fs.readdir(`/Volumes/`);
const { selectedVolumes } = await inquirer.prompt<{
  selectedVolumes: string[];
}>([
  {
    type: "checkbox",
    name: "selectedVolumes",
    message: "Pick volumes to pull videos from",
    choices: allVolumes,
    default: allVolumes.filter((volume) => volume.startsWith("Untitled")),
  },
]);

const multi = new Multiprogress();
console.time("Total time");
console.time("Scan time");
console.log("Scanning for videos...");
const videosByVolume: Record<
  string,
  {
    volume: string;
    chapterFilePaths: string[];
    cameraName: string;
    date: Date;
    vidNumber?: number;
    totalDuration?: number;
  }[]
> = {};
await Promise.all(
  selectedVolumes.map(async (volume) => {
    if (!videosByVolume[volume]) videosByVolume[volume] = [];

    await Promise.all(
      (
        await fs.readdir(`/Volumes/${volume}/DCIM`)
      )
        .filter((dir) => dir.startsWith("100"))
        .map(async (dir) =>
          Promise.all(
            (
              await fs.readdir(`/Volumes/${volume}/DCIM/${dir}`)
            )
              .filter((fileName) => fileName.endsWith(".MP4"))
              .map(async (fileName) => {
                const filePath = `/Volumes/${volume}/DCIM/${dir}/${fileName}`;
                const stats = await fs.stat(filePath);

                const [, vidNumber] = fileName
                  .match(/\d{2}(\d{4})/)
                  .map(Number);

                let cameraName =
                  videosByVolume[volume].find((v) => v.vidNumber === vidNumber)
                    ?.cameraName ||
                  (dir.includes("GOPRO")
                    ? await getDeviceNameFromFile(filePath)
                    : "NikonZ30");

                if (
                  !videosByVolume[volume].some((v) => v.vidNumber === vidNumber)
                ) {
                  videosByVolume[volume].push({
                    volume,
                    chapterFilePaths: [],
                    cameraName,
                    date: new Date(stats.mtimeMs),
                    vidNumber,
                    totalDuration: 0,
                  });
                }

                videosByVolume[volume]
                  .find((v) => v.vidNumber === vidNumber)
                  .chapterFilePaths.push(filePath);
              })
          )
        )
    );
  })
);
console.timeEnd("Scan time");

console.time("Getting video durations");
await Promise.all(
  Object.keys(videosByVolume).map((volume) =>
    Promise.all(
      videosByVolume[volume].map((video) =>
        Promise.all(
          video.chapterFilePaths.map((path) =>
            getDuration(path).then((dur) => (video.totalDuration += dur))
          )
        )
      )
    )
  )
);
console.timeEnd("Getting video durations");

const selections = await inquirer.prompt<
  Record<string, (typeof videosByVolume)[keyof typeof videosByVolume]>
>(
  Object.entries(videosByVolume).map(([volume, videos]) => ({
    type: "checkbox",
    name: volume,
    message: `Select videos to pull from ${volume}`,
    choices: videos
      .sort((a, b) => b.date.valueOf() - a.date.valueOf())
      .map((v) => ({
        name: `Timestamp: ${v.date.toLocaleString("da-DK", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}. Duration: ${secondsToTimemark(~~v.totalDuration)}. Camera: ${
          v.cameraName
        }. Vid No.: ${v.vidNumber}`,
        value: v,
      })),
  }))
);
const selectedVideos = Object.values(selections).flat();

// throw new Error("dry run - remove this line");

console.time("Copy/Concatenate time");
console.log(`Creating destination folder ${destinationFolder}...`);
await fs.mkdir(destinationFolder, { recursive: true });
console.log(`Copying videos to ${destinationFolder}...`);

const areThereMultipleVideosFromTheSameCamera = selectedVideos.some(
  ({ cameraName }, _, videos) =>
    videos.filter((v) => v.cameraName === cameraName).length > 1
);

await Promise.all(
  selectedVideos.map(async (video) => {
    const { cameraName, chapterFilePaths, vidNumber, totalDuration } = video;
    const destinationFile = areThereMultipleVideosFromTheSameCamera
      ? `${destinationFolder}/${sessionName}-${cameraName}-${vidNumber}.MP4`
      : `${destinationFolder}/${sessionName}-${cameraName}.MP4`;

    const destinationStat: Stats | null = await fs
      .stat(destinationFile)
      .catch(() => null);

    if (chapterFilePaths.length === 1) {
      const onlyVideo = chapterFilePaths[0];
      const sourceStat = await fs.stat(onlyVideo);

      if (destinationStat && sourceStat.size <= destinationStat.size) {
        console.log(
          `Already copied ${destinationFile.replace(
            destinationFolder + "/",
            ""
          )}`
        );
        return;
      }

      const bar = multi.newBar(
        `Copying ${destinationFile.replace(
          destinationFolder + "/",
          ""
        )} [:bar] :percent :etas`,
        { total: sourceStat.size }
      );

      await copyFile(onlyVideo, destinationFile, {
        onProgress: ({ writtenBytes, size }) => bar.update(writtenBytes / size),
      });

      return;
    }

    const ffmpegCommand = ffmpeg();
    for (const path of chapterFilePaths) ffmpegCommand.input(path);

    if (destinationStat) {
      const destinationDuration = await getDuration(destinationFile);

      if (~~destinationDuration === ~~totalDuration) {
        console.log(
          `Already concatenated ${destinationFile.replace(
            destinationFolder + "/",
            ""
          )}`
        );
        return;
      }
    }

    if (process.env.DEBUG) {
      console.log("ffmpeg " + ffmpegCommand._getArguments().join(" "));
    }

    let bar: ProgressBar;
    await new Promise((resolve, reject) =>
      ffmpegCommand
        .on("start", () => {
          bar = multi.newBar(
            `Concatenating ${destinationFile.replace(
              destinationFolder + "/",
              ""
            )} [:bar] :percent :etas`,
            { total: totalDuration }
          );
        })
        .on("progress", ({ timemark }) => {
          if (!bar.complete) {
            bar.update(timemarkToSeconds(timemark) / totalDuration);
          }
        })
        .on("end", () => {
          bar.update(1);
          bar.complete = true;
          resolve(undefined);
        })
        .on("error", reject)
        .mergeToFile(destinationFile, "/tmp")
    );
  })
);

console.timeEnd("Copy/Concatenate time");
console.timeEnd("Total time");

#!/usr/bin/env -S npx tsx

import { copyFile } from "copy-file";
import ffprobe from "ffprobe-client";
import ffmpeg from "fluent-ffmpeg";
import { Stats } from "fs";
import fs from "fs/promises";
import { GoProTelemetry } from "gopro-telemetry";
import Multiprogress from "multi-progress";

const extractGPMF = async (videoFile: string) => {
  for (const stream of (await ffprobe(videoFile)).streams) {
    if (stream.codec_tag_string !== "gpmd") continue;

    return extractGPMFAt(videoFile, stream.index);
  }
};
function timemarkToSeconds(timemark: string) {
  if (typeof timemark === "number") {
    return timemark;
  }

  if (timemark.indexOf(":") === -1 && timemark.indexOf(".") >= 0) {
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

const extractGPMFAt = async (
  videoFile: string,
  stream: number,
  buffer: Buffer<ArrayBuffer> = Buffer.alloc(0)
) =>
  new Promise<Buffer<ArrayBuffer>>((resolve, reject) =>
    ffmpeg(videoFile)
      .outputOption("-y")
      .outputOptions("-codec copy")
      .outputOptions(`-map 0:${stream}`)
      .outputOption("-f rawvideo")
      .on("error", reject)
      .pipe()
      .on("data", (chunk) => (buffer = Buffer.concat([buffer, chunk])))
      .on("end", () => resolve(buffer))
  );

async function getDeviceNameFromFile(videoPath: string): Promise<string> {
  const telemetry = await GoProTelemetry(
    { rawData: await extractGPMF(videoPath) },
    { raw: true }
  );

  // @ts-expect-error - The type definitions are wrong
  const DEVC = Array.isArray(telemetry.DEVC)
    ? // @ts-expect-error - The type definitions are wrong
      telemetry.DEVC[0]
    : // @ts-expect-error - The type definitions are wrong
      telemetry.DEVC;

  return DEVC.DVNM;
}

const sessionName = `2025-05-01-Exelerate-Soenderjyllandshallen`;
const destinationFolder = `/Volumes/@klarstrup2/${sessionName}`;

const multi = new Multiprogress();
console.time("Total time");
console.time("Scan time");
console.log("Scanning for videos...");
const videosByCamera: Record<
  string,
  {
    videos: string[];
  }
> = {};
await Promise.all(
  (
    await fs.readdir("/Volumes/")
  ).map(async (volume) => {
    if (!volume.startsWith("Untitled")) return;

    const dirs = await fs.readdir(`/Volumes/${volume}/DCIM`);
    await Promise.all(
      dirs.map(async (dir) => {
        if (!dir.startsWith("100")) return;

        const dirFiles = await fs.readdir(`/Volumes/${volume}/DCIM/${dir}`);

        let newestFile: {
          vidNumber?: number;
          mtimeMs?: number;
          file: string;
        } | null = null;
        for (const file of dirFiles) {
          if (!file.endsWith(".MP4")) continue;
          const filePath = `/Volumes/${volume}/DCIM/${dir}/${file}`;

          if (file.startsWith("DSC_")) {
            const stats = await fs.stat(filePath);
            if (newestFile === null || stats.mtimeMs > newestFile.mtimeMs) {
              newestFile = { mtimeMs: stats.mtimeMs, file: filePath };
            }
          } else {
            const [, chapterNumber, vidNumber] = file
              .match(/(\d{2})(\d{4})/)
              .map(Number);
            if (newestFile === null || vidNumber > newestFile.vidNumber) {
              newestFile = { vidNumber: vidNumber, file: filePath };
            }
          }
        }

        console.log(`Getting device name for ${newestFile.file}`);
        const cameraName = dir.includes("GOPRO")
          ? (await getDeviceNameFromFile(newestFile.file)).replace(
              /[^a-zA-Z0-9]/g,
              ""
            )
          : "NikonZ30";
        console.log(`Found camera name ${cameraName} for ${newestFile.file}`);

        if (!videosByCamera[cameraName])
          videosByCamera[cameraName] = { videos: [] };
        for (const file of dirFiles) {
          if (!file.endsWith(newestFile.file.slice(-8))) continue;

          const filePath = `/Volumes/${volume}/DCIM/${dir}/${file}`;

          videosByCamera[cameraName].videos.push(filePath);
        }
      })
    );
  })
);
console.timeEnd("Scan time");

console.time("Copy/Concatenate time");
console.log(`Creating destination folder ${destinationFolder}...`);
await fs.mkdir(destinationFolder, { recursive: true });
console.log(`Copying videos to ${destinationFolder}...`);
await Promise.all(
  Object.entries(videosByCamera).map(async ([camera, { videos }]) => {
    const destinationFile = `${destinationFolder}/${sessionName}-${camera}.MP4`;
    const destinationStat: Stats | null = await fs
      .stat(destinationFile)
      .catch(() => null);

    if (videos.length === 1) {
      const onlyVideo = videos[0];
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

    let totalDuration = 0;
    const ffmpegCommand = ffmpeg();
    for (const video of videos) {
      totalDuration += +(await ffprobe(video)).format.duration;
      ffmpegCommand.input(video);
    }

    if (destinationStat) {
      const destinationDuration = +(await ffprobe(destinationFile)).format
        .duration;

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
    await new Promise((resolve, reject) => {
      ffmpegCommand
        .on("progress", (progress) => {
          if (!bar) {
            bar = multi.newBar(
              `Concatenating ${destinationFile.replace(
                destinationFolder + "/",
                ""
              )} [:bar] :percent :etas`,
              { total: totalDuration }
            );
          }

          bar.update(timemarkToSeconds(progress.timemark) / totalDuration);
        })
        .on("end", () => {
          bar.update(1);
          bar.complete = true;
          resolve(undefined);
        })
        .on("error", reject)
        .mergeToFile(destinationFile, "/tmp");
    });
  })
);

console.timeEnd("Copy/Concatenate time");
console.timeEnd("Total time");

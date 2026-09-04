import multer, { FileFilterCallback } from "multer";
import { v2 as cloudinary } from "cloudinary";
import streamifier from "streamifier";
import express, { Request, Response, NextFunction } from "express";

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME!,
  api_key: process.env.CLOUDINARY_API_KEY!,
  api_secret: process.env.CLOUDINARY_API_SECRET!,
});

interface CloudinaryUploadResult {
  public_id: string;
  secure_url: string;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// ALLOWED MIME TYPES
const allowedMimeTypes = ["image/jpeg", "image/png", "image/jpg", "image/webp"];

// COMMON FILE FILTER
const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback,
): void => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Invalid file type. Only JPG, PNG, JPEG, and WEBP images are allowed.",
      ) as any,
      false,
    );
  }
};

const produceStorage = multer.memoryStorage();
export const uploadProduceImages = multer({
  storage: produceStorage,
  limits: { fileSize: MAX_FILE_SIZE, files: 3, fields: 10, fieldSize: 10 * 1024, parts: 13 },
  fileFilter,
}).fields([
  { name: "image1", maxCount: 1 },
  { name: "image2", maxCount: 1 },
  { name: "image3", maxCount: 1 },
]);

export const uploadProducerImages = multer({
  storage: produceStorage,
  limits: { fileSize: MAX_FILE_SIZE, files: 6, fields: 10, fieldSize: 10 * 1024, parts: 16 },
  fileFilter,
}).fields([
  { name: "profilePhoto", maxCount: 1 },
  { name: "farmImage1", maxCount: 1 },
  { name: "farmImage2", maxCount: 1 },
  { name: "farmImage3", maxCount: 1 },
  { name: "guarantorPhoto1", maxCount: 1 },
  { name: "guarantorPhoto2", maxCount: 1 },
]);

export const uploadFiles = multer({
  storage: produceStorage,
  limits: { fileSize: MAX_FILE_SIZE, files: 5, fields: 10, fieldSize: 10 * 1024, parts: 15 },
  fileFilter,
}).fields([{ name: "files", maxCount: 5 }]);

// 🚧 Middleware wrapper to catch Multer errors cleanly
export const handleUploadErrors = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res
        .status(400)
        .json({ error: "File too large. Maximum size is 5 MB per file." });
      return;
    }
    res.status(400).json({ error: "Upload could not be processed." });
    return;
  } else if (err) {
    res.status(400).json({ error: "Invalid upload." });
    return;
  }
  next();
};

// Helper function to upload a file buffer to Cloudinary
function hasAllowedImageSignature(buffer: Buffer): boolean {
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const webp = buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return jpeg || png || webp;
}

export const uploadToCloudinary = (
  fileBuffer: Buffer,
  folder: string,
): Promise<CloudinaryUploadResult> => {
  return new Promise((resolve, reject) => {
    if (!hasAllowedImageSignature(fileBuffer)) {
      reject(new Error("Invalid image content."));
      return;
    }
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", allowed_formats: ["jpg", "jpeg", "png", "webp"] },
      (error, result) => {
        if (error) return reject(error);

        if (!result) {
          return reject(new Error("Cloudinary upload failed: no result"));
        }
        resolve(result);
      },
    );

    streamifier.createReadStream(fileBuffer).pipe(uploadStream);
  });
};

export const deleteFromCloudinary = (publicId: string) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });
};

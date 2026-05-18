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
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
}).fields([
  { name: "image1", maxCount: 1 },
  { name: "image2", maxCount: 1 },
  { name: "image3", maxCount: 1 },
]);

export const uploadProducerImages = multer({
  storage: produceStorage,
  limits: { fileSize: MAX_FILE_SIZE },
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
  limits: { fileSize: MAX_FILE_SIZE },
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
    res.status(400).json({ error: `Upload error: ${err.message}` });
    return;
  } else if (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  next();
};

// Helper function to upload a file buffer to Cloudinary
export const uploadToCloudinary = (
  fileBuffer: Buffer,
  folder: string,
): Promise<CloudinaryUploadResult> => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder },
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

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import Admin from "../src/models/adminModel.js";
import "dotenv/config";

const seedAdmin = async () => {
  try {
    const MONGO_URI = process.env.MONGO_URI;
    if (!MONGO_URI) throw new Error("MONGO_URI not defined");

    await mongoose.connect(MONGO_URI);
    console.log("Connected to DB...");

    const email = "admin@example.com";
    const password = "yourpassword";
    const hashedPassword = await bcrypt.hash(password, 10);

    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      console.log("Admin already exists!");
      process.exit(0);
    }

    await Admin.create({
      firstName: "Super",
      lastName: "Admin",
      email: email,
      password: hashedPassword,
    });

    console.log("Admin successfully seeded!");
    process.exit(0);
  } catch (error) {
    console.error("Error seeding admin:", error);
    process.exit(1);
  }
};

seedAdmin();

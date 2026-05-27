import mongoose from "mongoose";
import { env } from "./env";

export const connectDB = async () => {
  try {
    mongoose.connection.on("error", (error) => {
      console.error("❌ MongoDB connection error:", error);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected");
    });

    mongoose.connection.on("reconnected", () => {
      console.log("🔄 MongoDB reconnected");
    });

    await mongoose.connect(env.secrets.mongoUri, {
      maxPoolSize: env.database.maxPoolSize,
      minPoolSize: env.database.minPoolSize,
      serverSelectionTimeoutMS: env.database.serverSelectionTimeoutMs,
      socketTimeoutMS: env.database.socketTimeoutMs,
    });

    console.log("✅ MongoDB Connected");
  } catch (error) {
    console.error("❌ DB Error:", error);
    process.exit(1);
  }
};

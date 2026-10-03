import mongoose from "mongoose";
import userModel from "../models/userModel.js";

export default async function connectDB(databaseUrl) {
    try {
        await mongoose.connect(databaseUrl)
    } catch (error) {
        // the message may contain the connection string, so only the error name is logged
        console.error(`Database connection failed (${error.name}). Check DATABASE_URL and that MongoDB is running.`)
        process.exit(1)
    }

    console.log('Database connected')

    mongoose.connection.on('error', (err) => {
        console.error(`Database error: ${err.name}`)
    })

    try {
        await userModel.syncIndexes()
    } catch (error) {
        console.warn(
            'Could not build the unique email index. Existing duplicate emails probably exist; run "npm run check:emails" to list them. New duplicates are still rejected by the application.'
        )
    }
}

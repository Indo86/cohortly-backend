import mongoose from "mongoose";

const userModel = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    photo: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    // Persisted role values: 'manager' is the conceptual INSTRUCTOR (see utils/roles.js).
    role: {
        type: String,
        enum: ['manager', 'student'],
        default: 'manager'
    },
    courses: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Course'
        }
    ],
    manager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
})

export default mongoose.model("User", userModel)

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
    // Set whenever the password is replaced. Tokens issued before it are rejected by verifyToken,
    // so a password change signs out every existing session. Unset = never changed (legacy accounts).
    passwordChangedAt: Date,
})

export default mongoose.model("User", userModel)

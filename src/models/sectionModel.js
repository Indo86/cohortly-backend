import mongoose from "mongoose";

// A section groups the lessons of exactly one course. Ownership always derives
// through the course. `order` is explicit; ties are broken by _id so the order is
// always deterministic (see utils/progress.js).
const sectionModel = new mongoose.Schema({
    course: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
        required: true
    },
    title: {type: String, required: true},
    order: {type: Number, required: true, default: 0}
}, {timestamps: true})

// not unique on purpose: reordering rewrites all positions in one bulk write
sectionModel.index({course: 1, order: 1})

export default mongoose.model('Section', sectionModel)

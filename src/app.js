import express from 'express'
import cors from 'cors'

import { getConfig } from './config/env.js'
import { PUBLIC_DIR } from './config/paths.js'
import authRoutes from './routes/authRoutes.js'
import paymentRoutes from './routes/paymentRoutes.js'
import courseRoutes from './routes/courseRoutes.js'
import studentRoutes from './routes/studentRoutes.js'
import overviewRoutes from './routes/overviewRoutes.js'
import structureRoutes from './routes/structureRoutes.js'
import learningRoutes from './routes/learningRoutes.js'
import quizRoutes from './routes/quizRoutes.js'
import aiRoutes from './routes/aiRoutes.js'
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js'

// Builds the Express app without starting it (so tests can mount it directly).
export const createApp = () => {
    const app = express()

    app.disable('x-powered-by')

    const { corsOrigins } = getConfig()

    app.use(
        cors({
            origin: (origin, cb) => {
                // non-browser clients (no Origin header) and allow-listed origins pass
                if (!origin || corsOrigins.includes(origin)) return cb(null, true)

                return cb(null, false)
            },
        })
    )
    app.use(express.json({ limit: '1mb' }))
    app.use(express.static(PUBLIC_DIR))

    app.get('/api/health', (req, res) => res.json({ status: 'ok' }))

    app.use('/api', authRoutes)
    app.use('/api', paymentRoutes)
    app.use('/api', courseRoutes)
    app.use('/api', studentRoutes)
    app.use('/api', structureRoutes)
    app.use('/api', learningRoutes)
    app.use('/api', quizRoutes)
    app.use('/api', aiRoutes)
    app.use('/api', overviewRoutes)

    app.use(notFoundHandler)
    app.use(errorHandler)

    return app
}

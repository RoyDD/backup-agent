#!/usr/bin/env node
import { runKnowledgeCli } from './cli'

process.exitCode = await runKnowledgeCli(process.argv.slice(2))

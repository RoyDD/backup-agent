#!/usr/bin/env node
import { runKnowledgeCli } from './cli'

process.exitCode = runKnowledgeCli(process.argv.slice(2))

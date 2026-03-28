---
name: system_analysis
description: "Examines CPU, Memory, Disk, and Network status to identify performance bottlenecks."
---

# System Analysis Skill

Use this skill when the user asks about the health or performance of their Linux machine.

## Available Actions
1. **CPU Check**: `lscpu` and `top -bn1 | head -n 20`
2. **Memory Check**: `free -h`
3. **Disk Check**: `df -h`
4. **Network Check**: `nload` or `ip a`

## Example Workflow
1. User: "Why is my computer slow?"
2. Agent: Use `run_command` with `top` or `free`.
3. Agent: Use these instructions to interpret the output.

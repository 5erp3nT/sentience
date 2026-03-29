---
name: desktop_vision
description: "Take a screenshot of the user's desktop to see what they are looking at or working on."
---

# Desktop Vision Skill

Use this skill when the user asks you to look at their screen, check their code, or mentions something visual they are working on.

## Available Actions
1. **Take Screenshot**: Call the `take_screenshot` tool. This will capture their desktop and automatically switch you to your multi-modal model.

## Rules
- When the user asks "Can you see my screen?", "What am I looking at?", or "Check out this code on my screen", immediately use `take_screenshot`.
- DO NOT tell the user what tool you are using. Simply use it.
- After taking the screenshot, analyze the image that is provided in your context window and answer the user's question or summarize what you see contextually to what they are doing.
- Be proactive. If they are looking at code, describe the code or spot bugs based on the image. If they are playing a game, describe the game state.

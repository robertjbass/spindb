# Custom Keyboard Shortcuts in Interactive Menus

The interactive menu supports custom keyboard shortcuts via raw stdin handling in `cli/ui/prompts.ts`. This pattern was used to implement Shift+Tab toggle for containers.

## Architecture

1. `enableGlobalEscape()` registers a stdin data handler (`onEscapeData`) at menu start
2. The handler intercepts raw terminal escape sequences before inquirer processes them
3. Custom actions can close the prompt and return special values to the caller

## Key Escape Sequences

- Escape: `0x1b` (single byte)
- Arrow Up: `\x1b[A` (bytes: 27, 91, 65)
- Arrow Down: `\x1b[B` (bytes: 27, 91, 66)
- Shift+Tab: `\x1b[Z` (bytes: 27, 91, 90)

## Adding a New Keyboard Shortcut

1. **Add state variables** at module scope in `prompts.ts`:
   ```typescript
   let myFeatureEnabled = false
   let myFeatureTriggered = false
   ```

2. **Detect the key** in `onEscapeData()`:
   ```typescript
   if (data.length === 3 && data[0] === 27 && data[1] === 91) {
     const keyCode = data[2]
     if (keyCode === YOUR_KEY_CODE && myFeatureEnabled) {
       myFeatureTriggered = true
       if (escapeReject) {
         escapeReject(new MyCustomError())
       }
       if (currentPromptUi?.close) {
         currentPromptUi.close()
       }
       return
     }
   }
   ```

3. **Add enable/disable functions**:
   ```typescript
   export function enableMyFeature(): void { myFeatureEnabled = true }
   export function disableMyFeature(): void { myFeatureEnabled = false }
   ```

4. **Handle in the prompt function** (catch the custom error, return special value):
   ```typescript
   } catch (error) {
     if (error instanceof MyCustomError) {
       return MY_SPECIAL_PREFIX + targetValue
     }
     throw error
   } finally {
     disableMyFeature()
   }
   ```

5. **Handle in the caller** (check for special prefix, perform action):
   ```typescript
   if (result.startsWith(MY_SPECIAL_PREFIX)) {
     const value = result.slice(MY_SPECIAL_PREFIX.length)
     // Perform custom action
   }
   ```

**Example:** See `TOGGLE_PREFIX` and toggle tracking in `prompts.ts` for Shift+Tab container toggle.

**Important:** Only enable custom key tracking in prompts that need it (e.g., `filterableListPrompt` with `enableToggle: true`). Always disable in the `finally` block.

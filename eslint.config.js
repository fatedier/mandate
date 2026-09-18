import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/target/**", "src/client/components/ui/**"]
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      ...tsPlugin.configs["recommended"].rules,
      ...reactHooks.configs["recommended-latest"].rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }]
    }
  },
  {
    files: [
      "src/client/components/QuestionCallout.tsx",
      "src/client/hooks/useTerminalSession.ts",
      "src/client/routes/sessions/AdoptDialog.tsx",
      "src/client/routes/sessions/SessionDetailPage.tsx",
      "src/client/routes/sessions/SessionsPage.tsx",
      "src/client/routes/sessions/WindowDetailPage.tsx",
      "src/client/routes/settings/MemoryPane.tsx",
      "src/client/routes/settings/useProviderCards.ts",
      "src/client/routes/settings/settings-config.ts",
      "src/client/routes/settings/SettingsConfigProvider.tsx",
      "src/client/routes/settings/SettingsPage.tsx",
      "src/client/routes/settings/SkillsPane.tsx",
      "src/client/routes/terminal/TerminalPage.tsx",
      "src/client/routes/window/chat/ChatMessageList.tsx",
      "src/client/routes/window/WindowPage.tsx",
      "src/client/shell/ConnectionIndicator.tsx"
    ],
    rules: {
      // React Hooks v7 currently reports intentional route-load and UI reset
      // effects in these existing components. Keep the exception local so new
      // files still get the rule.
      "react-hooks/set-state-in-effect": "off"
    }
  },
  {
    files: [
      "src/client/routes/settings/MemoryPane.tsx",
      "src/client/routes/settings/settings-config.ts",
      "src/client/routes/terminal/TerminalPage.tsx"
    ],
    rules: {
      // The refs rule misclassifies the object returned by useTerminalSession
      // as a React ref throughout TerminalPage render, and flags the
      // intentional latest-value refs (ref.current assigned during render) in
      // MemoryPane and useSaveUnit. Keep this narrow so new files still get
      // the rule.
      "react-hooks/refs": "off"
    }
  },
  {
    files: ["src/client/routes/sessions/PaneRowList.tsx"],
    rules: {
      // PaneRowList deliberately ships its row-data mappers next to the
      // component so every consumer (the Window page, the terminal's pane
      // switcher, tests) imports one path. Re-exporting from a helper module
      // trips the rule just the same, so the exception is the honest fix.
      // Keep it to this file so new files still get the rule.
      "react-refresh/only-export-components": "off"
    }
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx", "e2e/**/*.ts"],
    rules: {
      // Tests use loose mock payloads and fixture dispatchers extensively;
      // keeping no-explicit-any enabled there creates churn without improving
      // product type boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      // Component tests use probe components that intentionally capture hook
      // results into module-level variables for assertions.
      "react-hooks/globals": "off"
    }
  }
];

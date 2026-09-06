// Flat config: @eslint/js recommended + typescript-eslint strict.
// Formatting belongs to Prettier; nothing stylistic is enforced here, so the
// two tools cannot fight.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "docs/"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // Non-null assertions are used deliberately after explicit bounds/shape
      // checks throughout (noUncheckedIndexedAccess is on in tsconfig, which
      // is the stronger guarantee). Banning them here would be churn, not safety.
      "@typescript-eslint/no-non-null-assertion": "off",
      eqeqeq: ["error", "always"],
    },
  },
);

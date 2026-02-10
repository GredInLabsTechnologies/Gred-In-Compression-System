import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    sonarjs.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        rules: {
            'sonarjs/cognitive-complexity': ['error', 25],
            'sonarjs/no-duplicate-string': 'warn',
            'sonarjs/no-identical-functions': 'error',
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'warn',
        },
    },
    {
        ignores: ['dist/**', 'node_modules/**', 'bench/**', 'tools/**', 'coverage/**'],
    }
);

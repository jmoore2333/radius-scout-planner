import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: './edge/db/schema.ts',
  dialect: 'sqlite',
})

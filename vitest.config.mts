import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/int/**/*.int.spec.ts'],
    // Every int test file calls getPayload(config) in its own beforeAll,
    // which triggers Payload's dev-mode schema push (drizzle-kit push)
    // against the *same* ephemeral Postgres service container. With more
    // than one int test file, Vitest's default file-level parallelism runs
    // those pushes concurrently — drizzle-kit's push isn't safe under
    // concurrent execution (check-then-create, no locking), so the second
    // push can lose the race and fail with "relation ... already exists"
    // (seen in CI once tests/int/media.int.spec.ts was added alongside the
    // pre-existing tests/int/api.int.spec.ts). Forcing sequential file
    // execution is the right fix, not a workaround: these tests share one
    // stateful Postgres instance, so treating them as unable to run in
    // parallel is simply correct, independent of the schema-push race.
    fileParallelism: false,
  },
})

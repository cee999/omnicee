import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth/api";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);

/**
 * Sign-up is FAIL-CLOSED: only emails listed in the ALLOWED_EMAILS Convex env
 * var (comma separated) can create an account. With the var unset, nobody can.
 * This is a decision-support tool for a named operator, not a public product.
 */
const allowed = () =>
  (process.env.ALLOWED_EMAILS ?? "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: process.env.SITE_URL,
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!allowed().includes(String(user.email).toLowerCase())) {
              throw new APIError("FORBIDDEN", { message: "sign-up not permitted" });
            }
            return { data: user };
          },
        },
      },
    },
    plugins: [convex({ authConfig })],
  });

/** Every read the dashboard makes goes through this. Throws if signed out. */
export const requireUser = (ctx: GenericCtx<DataModel>) => authComponent.getAuthUser(ctx);

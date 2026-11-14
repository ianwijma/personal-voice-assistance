import type { Metadata } from "next"
import { AdminApp } from "@/components/admin/AdminApp.tsx"

export const metadata: Metadata = {
  title: "Assistant admin",
  description: "Settings of the personal voice assistant"
}

/** The admin front end (`/admin/`). */
export default function Page() {
  return <AdminApp />
}

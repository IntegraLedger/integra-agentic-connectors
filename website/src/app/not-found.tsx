import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Mark";

export const metadata: Metadata = {
  title: "Page not found",
  robots: null,
};

export default function NotFound() {
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="max-w-xl text-center">
        <div className="mb-6 flex justify-center">
          <Mark size={56} className="text-fd-muted-foreground" />
        </div>
        <p className="mb-2 font-mono text-sm text-fd-muted-foreground">404</p>
        <h1 className="mb-4 text-3xl font-bold tracking-tight">No page at this address</h1>
        <p className="mb-8 text-fd-muted-foreground">Every page is reachable from the home page.</p>
        <Link
          href="/"
          className="inline-flex items-center rounded-lg bg-fd-primary px-6 py-3 font-semibold text-fd-primary-foreground hover:bg-fd-primary/90"
        >
          Home
        </Link>
      </div>
    </main>
  );
}

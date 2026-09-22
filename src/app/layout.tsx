import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Amy",
  description: "Amy talks with people on Telegram. There is no dashboard.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

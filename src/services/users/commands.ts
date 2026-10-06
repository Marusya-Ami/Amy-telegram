import { prisma } from "@/lib/db/prisma";

const CONFIRM_WINDOW_MS = 15 * 60 * 1000;

export async function enableProactive(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { proactiveEnabled: true, aiEnabled: true },
  });
}

export async function disableProactive(userId: string): Promise<string[]> {
  await prisma.user.update({
    where: { id: userId },
    data: { proactiveEnabled: false, deleteRequestedAt: null },
  });
  return ["okay i won't message you first. you can still text me"];
}

export async function requestDelete(userId: string): Promise<string[]> {
  await prisma.user.update({
    where: { id: userId },
    data: { deleteRequestedAt: new Date() },
  });
  return ["that wipes your messages and what i remember about you. send /delete confirm if you mean it"];
}

export async function confirmDelete(userId: string, now = new Date()): Promise<{ texts: string[]; wipe: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const requested = user?.deleteRequestedAt?.getTime() ?? 0;
  if (!user || now.getTime() - requested > CONFIRM_WINDOW_MS) {
    return { texts: ["send /delete first"], wipe: false };
  }
  return { texts: ["done. i deleted your chat data"], wipe: true };
}

export async function wipeUser(userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}

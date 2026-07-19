import { useState } from "react";
import { useUser } from "@clerk/react";
import { MessageCircle, X, Send, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function FeedbackButton() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const displayName = user?.fullName ?? user?.firstName ?? "";
  const displayEmail = user?.primaryEmailAddress?.emailAddress ?? "";

  function handleOpen() {
    setDone(false);
    setMessage("");
    setName(displayName);
    setEmail(displayEmail);
    setOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setSubmitting(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          name: name.trim() || undefined,
          email: email.trim() || undefined,
          userId: user ? undefined : undefined,
        }),
      });
      setDone(true);
    } catch {
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={handleOpen}
        aria-label="Report an issue"
        className="fixed bottom-20 left-4 md:bottom-6 md:left-6 z-40 flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 hover:text-white rounded-full px-3 py-2 text-xs font-medium shadow-lg transition-colors"
      >
        <MessageCircle className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Report an issue</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl uppercase tracking-wide">
              Report an Issue
            </DialogTitle>
          </DialogHeader>

          {done ? (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <CheckCircle2 className="w-10 h-10 text-green-500" />
              <div>
                <p className="font-semibold text-foreground">Got it — thank you!</p>
                <p className="text-sm text-muted-foreground mt-1">
                  We'll look into it and get back to you if needed.
                </p>
              </div>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="fb-message">What's going on?</Label>
                <Textarea
                  id="fb-message"
                  placeholder="Describe the issue or anything that seems off…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  required
                  className="resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="fb-name">Your name <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="fb-name"
                    placeholder="Coach Stec"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="fb-email">Email <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Input
                    id="fb-email"
                    type="email"
                    placeholder="you@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting || !message.trim()}>
                  {submitting ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Send Report
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

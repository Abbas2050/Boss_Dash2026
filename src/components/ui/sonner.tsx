import { useEffect, useState } from "react";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const syncTheme = () => {
      const isLight = document.documentElement.classList.contains("light");
      setTheme(isLight ? "light" : "dark");
    };

    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-right"
      expand
      visibleToasts={4}
      offset={{ bottom: 20, right: 56 }}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:mr-4 group-[.toaster]:bg-card/95 group-[.toaster]:backdrop-blur-xl group-[.toaster]:text-foreground group-[.toaster]:border-border/70 group-[.toaster]:rounded-2xl group-[.toaster]:shadow-2xl group-[.toaster]:px-0 group-[.toaster]:py-0 overflow-hidden min-w-0 w-[min(440px,calc(100vw-6rem))] max-w-[calc(100vw-6rem)]",
          title: "group-[.toast]:px-4 group-[.toast]:pr-12 group-[.toast]:pt-3 group-[.toast]:text-foreground group-[.toast]:font-semibold",
          description: "group-[.toast]:px-4 group-[.toast]:pr-12 group-[.toast]:pb-3 group-[.toast]:text-muted-foreground group-[.toast]:text-xs",
          content: "group-[.toast]:p-0",
          closeButton:
            "group-[.toast]:!left-auto group-[.toast]:!right-2 group-[.toast]:!top-2 group-[.toast]:!border-border/60 group-[.toast]:!bg-background/70 group-[.toast]:!text-foreground hover:group-[.toast]:!bg-background",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      richColors
      closeButton
      {...props}
    />
  );
};

export { Toaster, toast };

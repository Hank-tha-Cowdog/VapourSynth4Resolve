import React, { useState } from 'react';

export interface TooltipProps {
    content: string;
    title?: string;
}

export const Tooltip = ({ children, content, title }: React.PropsWithChildren<TooltipProps>) => {
    const [visible, setVisible] = useState(false);
    const [pos, setPos] = useState({ x: 0, y: 0 });
    const handleMouseMove = (e: React.MouseEvent) => { setPos({ x: e.clientX + 15, y: e.clientY + 15 }); };
    return (
        <div onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)} onMouseMove={handleMouseMove} className="relative flex items-center z-50">
            {children}
            {visible && (
                <div className="fixed z-[100] w-64 p-3 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl pointer-events-none animate-in fade-in zoom-in-95 duration-100" style={{ top: pos.y, left: pos.x }}>
                    {title && <div className="text-xs font-bold text-amber-500 uppercase mb-1 tracking-wider">{title}</div>}
                    <div className="text-[11px] text-zinc-300 leading-relaxed">{content}</div>
                </div>
            )}
        </div>
    );
};

interface ButtonProps extends Omit<React.ComponentProps<'button'>, 'onClick'> {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline' | 'gemini' | 'success';
    size?: 'sm' | 'md' | 'lg' | 'icon';
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
}

export const Button = ({ children, variant = "primary", size = "md", className = "", ...props }: ButtonProps) => {
  const sizeStyles = {
      sm: "px-3 py-1.5 text-xs",
      md: "px-4 py-2 text-sm",
      lg: "px-6 py-3 text-base",
      icon: "p-2"
  };
  
  const baseStyles = "rounded-md font-medium transition-all duration-200 flex items-center justify-center gap-2 uppercase tracking-wide select-none disabled:opacity-50 disabled:cursor-not-allowed";
  
  const variants = {
    primary: "bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-900/20",
    secondary: "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700",
    ghost: "bg-transparent hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100",
    danger: "bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20",
    outline: "border border-zinc-600 text-zinc-300 hover:bg-zinc-800",
    gemini: "bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white shadow-lg shadow-purple-900/30 border border-white/10",
    success: "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20"
  };

  return <button className={`${baseStyles} ${sizeStyles[size]} ${variants[variant]} ${className}`} {...props}>{children}</button>;
};

export const Badge = ({ children, color = "zinc" }: { children?: React.ReactNode, color?: string }) => {
    const colorClasses: Record<string, string> = {
        zinc: "bg-zinc-800 text-zinc-400",
        purple: "bg-purple-500/10 text-purple-400 border border-purple-500/20",
        green: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
        orange: "bg-orange-500/10 text-orange-400 border border-orange-500/20",
        blue: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
        red: "bg-red-500/10 text-red-400 border border-red-500/20",
    };
    return <span className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${colorClasses[color] || colorClasses.zinc}`}>{children}</span>;
};
declare module 'lucide-react' {
  import { ComponentType, SVGProps } from 'react';

  export interface LucideIconProps extends SVGProps<SVGSVGElement> {
    size?: number;
    strokeWidth?: number;
    color?: string;
    absoluteStrokeWidth?: boolean;
  }

  type LucideIcon = ComponentType<LucideIconProps>;

  // Export all icons used in the app
  export const Activity: LucideIcon;
  export const Bell: LucideIcon;
  export const Check: LucideIcon;
  export const ChevronDown: LucideIcon;
  export const ChevronRight: LucideIcon;
  export const Clock: LucideIcon;
  export const Code2: LucideIcon;
  export const Command: LucideIcon;
  export const Copy: LucideIcon;
  export const Crown: LucideIcon;
  export const Eye: LucideIcon;
  export const EyeOff: LucideIcon;
  export const FileCode2: LucideIcon;
  export const FilePlus2: LucideIcon;
  export const Folder: LucideIcon;
  export const FolderInput: LucideIcon;
  export const FolderPlus: LucideIcon;
  export const GitBranch: LucideIcon;
  export const Globe2: LucideIcon;
  export const Home: LucideIcon;
  export const LayoutDashboard: LucideIcon;
  export const LogOut: LucideIcon;
  export const Mail: LucideIcon;
  export const MessageSquare: LucideIcon;
  export const MoreHorizontal: LucideIcon;
  export const Pencil: LucideIcon;
  export const Play: LucideIcon;
  export const Plus: LucideIcon;
  export const RefreshCw: LucideIcon;
  export const Save: LucideIcon;
  export const Search: LucideIcon;
  export const Settings2: LucideIcon;
  export const Share2: LucideIcon;
  export const ShieldCheck: LucideIcon;
  export const Sparkles: LucideIcon;
  export const Terminal: LucideIcon;
  export const Trash2: LucideIcon;
  export const UserMinus: LucideIcon;
  export const UserPlus: LucideIcon;
  export const UserRound: LucideIcon;
  export const Users: LucideIcon;
  export const X: LucideIcon;
  export const Zap: LucideIcon;
}
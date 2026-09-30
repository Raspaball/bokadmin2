import { Settings, Upload, RefreshCw, Rss, Layout, LogOut, BookOpen, Tags, Store, Link2 } from 'lucide-react';

interface MenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const menuItems: MenuItem[] = [
  { id: 'katalog', label: 'Shopifykatalog', icon: <Store className="size-4" /> },
  { id: 'import', label: 'Bokbasen', icon: <Upload className="size-4" /> },
  { id: 'update', label: 'Oppdatering', icon: <RefreshCw className="size-4" /> },
  { id: 'genres', label: 'Sjangre', icon: <Tags className="size-4" /> },
  { id: 'handles', label: 'Handles', icon: <Link2 className="size-4" /> },
  { id: 'feeds', label: 'Strømmer', icon: <Rss className="size-4" /> },
  { id: 'cms', label: 'CMS', icon: <Layout className="size-4" /> },
  { id: 'innstillinger', label: 'Innstillinger', icon: <Settings className="size-4" /> },
];

interface SidebarProps {
  activeItem: string;
  onSelectItem: (id: string) => void;
  onLogout?: () => void;
  shopDomain?: string | null;
  shopName?: string | null;
  userEmail?: string | null;
}

export function Sidebar({ activeItem, onSelectItem, onLogout, shopDomain, shopName, userEmail }: SidebarProps) {
  return (
    <div className="w-64 bg-white border-r border-gray-200 h-screen overflow-hidden flex flex-col">
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <BookOpen className="size-6 text-blue-600" />
          <h1 className="text-xl font-semibold text-gray-900">Bokadmin</h1>
        </div>
        <p className="text-xs text-gray-500 mt-1">Administrasjonsverktøy</p>
      </div>
      <nav className="p-3 space-y-1 flex-1 overflow-y-auto">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onSelectItem(item.id)}
            className={`
              w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors
              ${activeItem === item.id ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-100 text-gray-700'}
            `}
          >
            <span className="flex-shrink-0">{item.icon}</span>
            <span className="flex-1 text-left">{item.label}</span>
          </button>
        ))}
      </nav>
      {(shopDomain || userEmail) && (
        <div className="px-3 pb-2">
          <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600 space-y-0.5">
            {shopDomain && (
              <>
                <p className="font-medium text-gray-800 truncate">
                  {shopName || shopDomain.replace('.myshopify.com', '')}
                </p>
                <a
                  href={`https://${shopDomain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline truncate block"
                >
                  {shopDomain}
                </a>
              </>
            )}
            {userEmail && (
              <p className="text-gray-500 truncate">{userEmail}</p>
            )}
          </div>
        </div>
      )}
      {onLogout && (
        <div className="p-3 border-t border-gray-200">
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <LogOut className="size-4" />
            Logg ut
          </button>
        </div>
      )}
    </div>
  );
}

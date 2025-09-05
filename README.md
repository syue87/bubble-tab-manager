# Bubble Tab Manager

Smart tab organization and management for Bubble.io development workflow.

## 🚀 Features

### 📁 **Automatic Tab Grouping**
- Groups tabs by app and version across editor and preview pages
- Intelligent per-window naming (single-app vs multi-app)
- Respects pinned tabs and manual user moves
- **NEW in v1.2.1**: Enhanced persistence survives browser idle and service worker suspension

### 🏷️ **Smart Tab Titles** 
- Automatically scrapes branch names from Bubble editor
- Consistent editor tab titles with app name display
- Dynamic favicons reflecting current editor section (Design 🎨, Workflow 🔄, Data 📊)
- **IMPROVED in v1.2.1**: Faster branch name detection with real-time URL change monitoring

### 🎨 **Intelligent Color Management**
- Reserved colors: Test (blue), Live (green)
- Automatic color assignment for other branches
- User customizations override all defaults

### 💾 **Persistent Settings**
- Remembers group names, colors, and preferences  
- Survives browser restarts and extension updates
- **ENHANCED in v1.2.1**: Robust recovery from service worker suspension

### 🌐 **Custom Domain Support**
- Groups preview tabs on your own domains
- Strict security validation prevents unauthorized mapping
- Requires explicit setup with `debug_mode=true` parameter

## 📦 Installation

### Chrome Web Store (Recommended)
*Coming Soon - Extension under review*

### Manual Installation
1. Download the latest release or clone this repository
2. Run `npm install && npm run build`
3. Open Chrome → `chrome://extensions/`
4. Enable "Developer mode" → Click "Load unpacked"
5. Select the `dist/` folder

## 🎯 Usage

### Basic Operation
1. **Open Bubble tabs** - Extension automatically detects editor and preview tabs
2. **Tabs group automatically** - Same app/version tabs group together
3. **Customize as needed** - Rename groups and change colors through Chrome's native UI

### Custom Domain Setup
To group tabs on your custom domains:

1. **Establish the version** by visiting an editor tab:
   ```
   https://bubble.io/page?id=myapp&version=dev
   ```

2. **Visit your custom domain with security parameters**:
   ```
   https://app.example.com/version-dev/dashboard?debug_mode=true
   ```
   
   ⚠️ Both `/version-xxx` path and `debug_mode=true` parameter are required for security.

### Editor Favicons
Browser tab favicons automatically update based on your current editor section:
- **Design** → 🎨
- **Workflow** → 🔄  
- **Data** → 📊
- **Backend Workflows** → ⚙️
- **Logs** → 📋

## ⚙️ Settings

The extension works automatically with smart defaults. Customization options:

- **Group Names**: Rename through Chrome's group context menu
- **Colors**: Change through Chrome's group color picker
- **Manual Grouping**: Drag tabs to override automatic grouping

## 🛠️ Development

### Prerequisites
- Node.js 18+
- Chrome Browser

### Setup
```bash
# Clone repository
git clone [repository-url]
cd bubble-tab-manager

# Install dependencies
npm install

# Development build (watch mode)
npm run dev

# Production build
npm run build
```

### Build Scripts
- `npm run dev` - Development build with watch mode
- `npm run build` - Production build
- `npm run lint` - Code linting
- `npm run format` - Code formatting

## 🔒 Security & Privacy

- **Minimal Permissions**: Only requests necessary Chrome extension permissions
- **No Data Collection**: All data stays local to your browser
- **Custom Domain Security**: Strict 4-rule validation prevents unauthorized domain mapping
- **Open Source**: Code available for audit and contribution

## 🐛 Troubleshooting

### Common Issues

**Tabs not grouping?**
- Ensure you have 2+ tabs for the same app/version
- Check that tabs aren't pinned (pinned tabs are never grouped)

**Color or title changes unexpectedly?**
- This issue has been resolved in v1.2.1
- Groups now maintain stable colors and titles during branch switches
- Enhanced persistence layer prevents data loss after browser idle

**Custom domain not working?**
- Add `?debug_mode=true` to your URL
- Ensure URL contains `/version-xxx` path segment  
- Visit the editor for that version first to establish it in storage

**Groups have wrong names/colors?**
- Extension learns branch names over time as you use the editor
- You can manually rename groups through Chrome's interface

### Debug Commands
Open Chrome DevTools in the extension's service worker console:

```javascript
// View extension status
chrome.runtime.sendMessage({type: 'GET_REGISTRY_INFO'}, console.log)

// Check custom domain detection
chrome.runtime.sendMessage({type: 'GET_CUSTOM_DOMAIN_STATUS'}, console.log)
```

## 📋 Changelog

### v1.2.1
- **OPTIMIZATION**: Removed unnecessary `activeTab` permission for cleaner Chrome Web Store submission
- **STREAMLINED**: Extension now uses minimal required permissions only
- **IMPROVED**: Optimized for Chrome Web Store review process

### v1.2.0  
- **NEW**: Enhanced persistence layer survives browser idle and service worker suspension
- **IMPROVED**: Faster branch name detection with real-time URL change monitoring
- **ENHANCED**: Robust recovery from service worker suspension
- **FIXED**: Context menu initialization issues
- **OPTIMIZATION**: Comprehensive code cleanup and performance improvements

## 📝 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

Contributions welcome! Please read our contributing guidelines and submit pull requests.

---

**Made for Bubble.io developers by developers** 🫧
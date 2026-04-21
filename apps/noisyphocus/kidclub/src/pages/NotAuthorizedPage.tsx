export default function NotAuthorized() {
  return (
    <div className="flex flex-col items-center justify-center h-screen text-center">
      <h1 className="text-2xl font-bold mb-4">🚫 Access Denied</h1>
      <p>You do not have permission to view this page.</p>
    </div>
  );
}
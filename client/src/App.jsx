import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Room from './pages/Room.jsx';

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/lobby/:code" element={<Room />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </div>
  );
}
